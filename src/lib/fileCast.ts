import { deleteField, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export const LOCAL_STREAM_URL = 'local-stream';
export const MAX_CAST_PEERS = 8;

type SdpBlob = { type: 'offer' | 'answer'; sdp: string; from: string; gen?: number };
type IceBlob = { from: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
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
      candidates: {},
    }, { merge: true });
    await updateDoc(ref, payload);
  }
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
  const appliedOffer = new Map<string, string>();
  const appliedAnswer = new Map<string, string>();
  const appliedCandidates = new Set<string>();
  const remoteTracks = new Map<string, MediaStreamTrack>();
  const gen = Date.now();
  let localStream = input.stream ?? null;
  let unsub: (() => void) | null = null;
  let closed = false;
  let members: Record<string, { name?: string; role?: string }> = {};
  let offers: Record<string, SdpBlob> = {};
  let answers: Record<string, SdpBlob> = {};
  let candidates: Record<string, Record<string, IceBlob>> = {};

  const publishRemote = () => {
    if (role !== 'guest') return;
    const tracks = [...remoteTracks.values()];
    if (!tracks.length) {
      input.onRemoteStream?.(null);
      return;
    }
    input.onRemoteStream?.(new MediaStream(tracks));
  };

  const closePeer = (peerUid: string) => {
    const pc = peers.get(peerUid);
    pc?.getSenders().forEach((sender) => sender.track?.stop());
    pc?.close();
    peers.delete(peerUid);
    makingOffer.delete(peerUid);
    appliedOffer.delete(peerUid);
    appliedAnswer.delete(peerUid);
    for (const mark of [...appliedCandidates]) {
      if (mark.startsWith(`${peerUid}:`)) appliedCandidates.delete(mark);
    }
  };

  const ensurePeer = (peerUid: string) => {
    let pc = peers.get(peerUid);
    if (pc) return pc;
    pc = new RTCPeerConnection(RTC_CONFIG);
    peers.set(peerUid, pc);
    if (role === 'host' && localStream) {
      localStream.getTracks().forEach((track) => {
        pc!.addTrack(track.clone(), localStream!);
      });
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate || closed) return;
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      void patchCast(roomId, {
        [`candidates.${pairKey(uid, peerUid)}.${id}`]: {
          from: uid,
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };
    pc.ontrack = (event) => {
      if (role !== 'guest') return;
      const incoming = event.streams[0];
      if (incoming) {
        incoming.getTracks().forEach((track) => remoteTracks.set(track.kind, track));
      } else {
        remoteTracks.set(event.track.kind, event.track);
      }
      event.track.addEventListener('ended', () => {
        remoteTracks.delete(event.track.kind);
        publishRemote();
      });
      publishRemote();
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed') {
        closePeer(peerUid);
        if (role === 'host') {
          const key = pairKey(uid, peerUid);
          void patchCast(roomId, {
            [`offers.${key}`]: deleteField(),
            [`answers.${key}`]: deleteField(),
            [`candidates.${key}`]: deleteField(),
          }).then(() => connectTo(peerUid));
        } else {
          input.onError('Could not reach the host. Same Wi‑Fi works more reliably.');
        }
      }
    };
    return pc;
  };

  const flushCandidates = async (peerUid: string) => {
    const pc = peers.get(peerUid);
    if (!pc?.currentRemoteDescription) return;
    const bag = candidates[pairKey(uid, peerUid)] || {};
    for (const [id, row] of Object.entries(bag)) {
      if (!row || row.from === uid || !row.candidate) continue;
      const mark = `${peerUid}:${id}`;
      if (appliedCandidates.has(mark)) continue;
      appliedCandidates.add(mark);
      try {
        await pc.addIceCandidate({
          candidate: row.candidate,
          sdpMid: row.sdpMid,
          sdpMLineIndex: row.sdpMLineIndex,
        });
      } catch {
        appliedCandidates.delete(mark);
      }
    }
  };

  const connectTo = async (peerUid: string) => {
    if (closed || role !== 'host' || !localStream || peerUid === uid || makingOffer.has(peerUid)) return;
    const existing = peers.get(peerUid);
    if (existing && existing.signalingState !== 'stable') return;
    if (existing?.currentRemoteDescription) return;
    makingOffer.add(peerUid);
    const key = pairKey(uid, peerUid);
    try {
      const pc = ensurePeer(peerUid);
      if (pc.signalingState !== 'stable' || pc.currentRemoteDescription) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchCast(roomId, {
        [`offers.${key}`]: { type: 'offer', sdp: local.sdp, from: uid, gen },
        [`answers.${key}`]: deleteField(),
      });
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer.delete(peerUid);
    }
  };

  const handleOffer = async (peerUid: string, offer: SdpBlob) => {
    if (closed || role !== 'guest' || offer.from === uid || !offer.sdp) return;
    if (appliedOffer.get(peerUid) === offer.sdp) {
      void flushCandidates(peerUid);
      return;
    }
    closePeer(peerUid);
    const pc = ensurePeer(peerUid);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      appliedOffer.set(peerUid, offer.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchCast(roomId, {
        [`answers.${pairKey(uid, peerUid)}`]: { type: 'answer', sdp: local.sdp, from: uid, gen: offer.gen },
      });
      await flushCandidates(peerUid);
    } catch (err) {
      console.error(err);
      input.onError('Could not start the live stream. Refresh and try again.');
    }
  };

  const handleAnswer = async (peerUid: string, answer: SdpBlob) => {
    if (role !== 'host' || !answer.sdp || answer.from === uid) return;
    const pc = peers.get(peerUid);
    if (!pc) return;
    if (appliedAnswer.get(peerUid) === answer.sdp) {
      void flushCandidates(peerUid);
      return;
    }
    if (pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      appliedAnswer.set(peerUid, answer.sdp);
      await flushCandidates(peerUid);
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
      void flushCandidates(id);
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
      candidates = data.candidates && typeof data.candidates === 'object'
        ? data.candidates as typeof candidates
        : {};
      const liveCount = Object.keys(members).length;
      if (!members[uid] && liveCount >= MAX_CAST_PEERS) {
        input.onError('Local stream is full (max 8).');
        leave();
        return;
      }
      if (members[uid] || role === 'host') syncPeers();
    });

    if (role === 'host') {
      await patchCast(roomId, {
        offers: {},
        answers: {},
        candidates: {},
        hostUid: uid,
        [`members.${uid}`]: { name: input.name, role, joinedAt: Date.now() },
      });
    } else {
      await patchCast(roomId, {
        [`members.${uid}`]: { name: input.name, role, joinedAt: Date.now() },
      });
    }
    return !closed;
  };

  const leave = () => {
    unsub?.();
    unsub = null;
    for (const id of [...peers.keys()]) closePeer(id);
    remoteTracks.clear();
    input.onRemoteStream?.(null);
    const fields: Record<string, unknown> = {
      [`members.${uid}`]: deleteField(),
    };
    if (role === 'host') {
      fields.hostUid = deleteField();
      fields.offers = {};
      fields.answers = {};
      fields.candidates = {};
    } else {
      for (const key of Object.keys(offers)) {
        if (key.includes(uid)) fields[`offers.${key}`] = deleteField();
      }
      for (const key of Object.keys(answers)) {
        if (key.includes(uid)) fields[`answers.${key}`] = deleteField();
      }
      for (const key of Object.keys(candidates)) {
        if (key.includes(uid)) fields[`candidates.${key}`] = deleteField();
      }
    }
    void patchCast(roomId, fields);
  };

  const destroy = () => {
    closed = true;
    leave();
  };

  return { join, destroy };
}
