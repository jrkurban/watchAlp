import { deleteField, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export const LOCAL_STREAM_URL = 'local-stream';
export const MAX_CAST_PEERS = 8;

type SdpBlob = { type: 'offer' | 'answer'; sdp: string; from: string };

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export function isLocalStreamUrl(url: string) {
  return url === LOCAL_STREAM_URL || url.startsWith('blob:');
}

export function captureVideoStream(video: HTMLVideoElement): MediaStream | null {
  const media = video as HTMLVideoElement & {
    captureStream?: (fps?: number) => MediaStream;
    mozCaptureStream?: (fps?: number) => MediaStream;
  };
  const capture = media.captureStream || media.mozCaptureStream;
  if (!capture) return null;
  try {
    const stream = capture.call(video);
    return stream.getVideoTracks().length > 0 ? stream : null;
  } catch {
    return null;
  }
}

function castDocId(roomId: string) {
  return `${roomId}__cast`;
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

async function patchCast(roomId: string, fields: Record<string, unknown>) {
  const ref = doc(db, 'rooms', castDocId(roomId));
  const payload = {
    ...fields,
    currentVideoUrl: 'cast',
    updatedAt: new Date().toISOString(),
  };
  try {
    await updateDoc(ref, payload);
  } catch {
    await setDoc(ref, {
      currentVideoUrl: 'cast',
      updatedAt: payload.updatedAt,
      members: {},
      offers: {},
      answers: {},
    }, { merge: true });
    await updateDoc(ref, payload);
  }
}

function waitForIce(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    window.setTimeout(finish, 3500);
  });
}

export type FileCastSession = {
  join: () => Promise<boolean>;
  destroy: () => void;
};

export function startFileCast(input: {
  roomId: string;
  uid: string;
  name: string;
  role: 'host' | 'guest';
  stream?: MediaStream;
  onRemoteStream?: (stream: MediaStream | null) => void;
  onError: (message: string) => void;
}): FileCastSession {
  const { roomId, uid, role } = input;
  const peers = new Map<string, RTCPeerConnection>();
  const makingOffer = new Set<string>();
  let localStream = input.stream ?? null;
  let unsub: (() => void) | null = null;
  let closed = false;
  let members: Record<string, { name?: string; role?: string }> = {};
  let offers: Record<string, SdpBlob> = {};
  let answers: Record<string, SdpBlob> = {};

  const closePeer = (peerUid: string) => {
    peers.get(peerUid)?.close();
    peers.delete(peerUid);
    makingOffer.delete(peerUid);
  };

  const ensurePeer = (peerUid: string) => {
    let pc = peers.get(peerUid);
    if (pc) return pc;
    pc = new RTCPeerConnection(RTC_CONFIG);
    peers.set(peerUid, pc);
    if (role === 'host' && localStream) {
      localStream.getTracks().forEach((track) => pc!.addTrack(track, localStream!));
    }
    pc.ontrack = (event) => {
      if (role !== 'guest') return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      input.onRemoteStream?.(stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed') {
        closePeer(peerUid);
        if (role === 'host') void connectTo(peerUid);
      }
    };
    return pc;
  };

  const connectTo = async (peerUid: string) => {
    if (closed || role !== 'host' || !localStream || peerUid === uid || makingOffer.has(peerUid)) return;
    const existing = peers.get(peerUid);
    if (existing && (existing.currentRemoteDescription || existing.signalingState !== 'stable')) return;
    const key = pairKey(uid, peerUid);
    makingOffer.add(peerUid);
    try {
      const pc = ensurePeer(peerUid);
      if (pc.signalingState !== 'stable' || pc.currentRemoteDescription) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchCast(roomId, {
        [`offers.${key}`]: { type: 'offer', sdp: local.sdp, from: uid },
        [`answers.${key}`]: deleteField(),
      });
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer.delete(peerUid);
    }
  };

  const handleOffer = async (peerUid: string, offer: SdpBlob) => {
    if (closed || role !== 'guest' || offer.from === uid) return;
    const pc = ensurePeer(peerUid);
    if (pc.currentRemoteDescription || pc.signalingState !== 'stable') return;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchCast(roomId, {
        [`answers.${pairKey(uid, peerUid)}`]: { type: 'answer', sdp: local.sdp, from: uid },
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleAnswer = async (peerUid: string, answer: SdpBlob) => {
    if (role !== 'host') return;
    const pc = peers.get(peerUid);
    if (!pc || answer.from === uid || pc.currentRemoteDescription) return;
    if (pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (err) {
      console.error(err);
    }
  };

  const syncPeers = () => {
    const ids = Object.keys(members).filter((id) => id !== uid);
    for (const id of [...peers.keys()]) {
      if (!ids.includes(id)) closePeer(id);
    }
    for (const id of ids) {
      if (role === 'host') void connectTo(id);
      const key = pairKey(uid, id);
      const offer = offers[key];
      const answer = answers[key];
      if (offer && offer.from === id) void handleOffer(id, offer);
      if (answer && answer.from === id) void handleAnswer(id, answer);
    }
  };

  const join = async () => {
    if (closed) return false;
    if (role === 'host' && !localStream) {
      input.onError('This browser cannot stream a local file. Try Chrome or Edge.');
      return false;
    }

    try {
      const existing = await getDoc(doc(db, 'rooms', castDocId(roomId)));
      const data = existing.exists() ? existing.data() : undefined;
      const raw = data?.members && typeof data.members === 'object'
        ? data.members as Record<string, unknown>
        : {};
      if (!raw[uid] && Object.keys(raw).length >= MAX_CAST_PEERS) {
        input.onError('Local stream is full (max 8).');
        return false;
      }
    } catch {
      // Join write will surface permission errors.
    }

    unsub = onSnapshot(doc(db, 'rooms', castDocId(roomId)), (snap) => {
      if (closed) return;
      const data = snap.exists() ? snap.data() : {};
      members = data.members && typeof data.members === 'object' ? data.members as typeof members : {};
      offers = data.offers && typeof data.offers === 'object' ? data.offers as typeof offers : {};
      answers = data.answers && typeof data.answers === 'object' ? data.answers as typeof answers : {};
      const liveCount = Object.keys(members).length;
      if (!members[uid] && liveCount >= MAX_CAST_PEERS) {
        input.onError('Local stream is full (max 8).');
        leave();
        return;
      }
      if (members[uid] || role === 'host') syncPeers();
    });

    await patchCast(roomId, {
      [`members.${uid}`]: { name: input.name, role, joinedAt: Date.now() },
      ...(role === 'host' ? { hostUid: uid } : {}),
    });
    return !closed;
  };

  const leave = () => {
    unsub?.();
    unsub = null;
    for (const id of [...peers.keys()]) closePeer(id);
    input.onRemoteStream?.(null);
    const fields: Record<string, unknown> = {
      [`members.${uid}`]: deleteField(),
    };
    if (role === 'host') fields.hostUid = deleteField();
    for (const key of Object.keys(offers)) {
      if (key.includes(uid)) fields[`offers.${key}`] = deleteField();
    }
    for (const key of Object.keys(answers)) {
      if (key.includes(uid)) fields[`answers.${key}`] = deleteField();
    }
    void patchCast(roomId, fields);
  };

  const destroy = () => {
    closed = true;
    leave();
  };

  return { join, destroy };
}
