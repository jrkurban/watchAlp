import { deleteField, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export const MAX_VOICE_PEERS = 8;

export type VoiceMember = {
  uid: string;
  name: string;
  muted: boolean;
};

type SdpBlob = { type: 'offer' | 'answer'; sdp: string; from: string };

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export function voiceDocId(roomId: string) {
  return `${roomId}__voice`;
}

export function pairKey(a: string, b: string) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function isOfferer(self: string, other: string) {
  return self < other;
}

async function patchVoice(roomId: string, fields: Record<string, unknown>) {
  const ref = doc(db, 'rooms', voiceDocId(roomId));
  const payload = {
    ...fields,
    currentVideoUrl: 'voice',
    updatedAt: new Date().toISOString(),
  };
  try {
    await updateDoc(ref, payload);
  } catch {
    await setDoc(ref, {
      currentVideoUrl: 'voice',
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

export type VoiceSession = {
  join: () => Promise<boolean>;
  leave: () => void;
  setMuted: (muted: boolean) => void;
  setName: (name: string) => void;
  destroy: () => void;
};

export function listenVoiceMembers(roomId: string, onMembers: (members: VoiceMember[]) => void) {
  return onSnapshot(doc(db, 'rooms', voiceDocId(roomId)), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const raw = data.members && typeof data.members === 'object'
      ? data.members as Record<string, { name?: string; muted?: boolean }>
      : {};
    onMembers(Object.entries(raw).map(([id, row]) => ({
      uid: id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Guest',
      muted: Boolean(row.muted),
    })));
  }, () => onMembers([]));
}

export function startVoiceSession(input: {
  roomId: string;
  uid: string;
  name: string;
  onMembers: (members: VoiceMember[]) => void;
  onError: (message: string) => void;
}): VoiceSession {
  const { roomId, uid } = input;
  let name = input.name;
  const peers = new Map<string, RTCPeerConnection>();
  const remotes = new Map<string, HTMLAudioElement>();
  const makingOffer = new Set<string>();
  let localStream: MediaStream | null = null;
  let unsub: (() => void) | null = null;
  let closed = false;
  let muted = false;
  let members: Record<string, { name?: string; muted?: boolean }> = {};
  let offers: Record<string, SdpBlob> = {};
  let answers: Record<string, SdpBlob> = {};

  const attachRemote = (peerUid: string, stream: MediaStream) => {
    let audio = remotes.get(peerUid);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      document.body.appendChild(audio);
      remotes.set(peerUid, audio);
    }
    audio.srcObject = stream;
    void audio.play().catch(() => {});
  };

  const closePeer = (peerUid: string) => {
    peers.get(peerUid)?.close();
    peers.delete(peerUid);
    makingOffer.delete(peerUid);
    const audio = remotes.get(peerUid);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      remotes.delete(peerUid);
    }
  };

  const ensurePeer = (peerUid: string) => {
    let pc = peers.get(peerUid);
    if (pc) return pc;
    pc = new RTCPeerConnection(RTC_CONFIG);
    peers.set(peerUid, pc);
    localStream?.getTracks().forEach((track) => pc!.addTrack(track, localStream!));
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      attachRemote(peerUid, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed' || pc?.connectionState === 'closed' || pc?.connectionState === 'disconnected') {
        if (pc.connectionState === 'failed') {
          closePeer(peerUid);
          void connectTo(peerUid);
        }
      }
    };
    return pc;
  };

  const connectTo = async (peerUid: string) => {
    if (closed || !localStream || peerUid === uid || makingOffer.has(peerUid)) return;
    if (!isOfferer(uid, peerUid)) return;
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
      await patchVoice(roomId, {
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
    if (closed || !localStream || offer.from === uid) return;
    const pc = ensurePeer(peerUid);
    if (pc.currentRemoteDescription || pc.signalingState !== 'stable') return;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchVoice(roomId, {
        [`answers.${pairKey(uid, peerUid)}`]: { type: 'answer', sdp: local.sdp, from: uid },
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleAnswer = async (peerUid: string, answer: SdpBlob) => {
    const pc = peers.get(peerUid);
    if (!pc || answer.from === uid || pc.currentRemoteDescription) return;
    if (pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (err) {
      console.error(err);
    }
  };

  const syncPeers = (nextMembers: Record<string, { name?: string; muted?: boolean }>) => {
    const ids = Object.keys(nextMembers).filter((id) => id !== uid);
    for (const id of [...peers.keys()]) {
      if (!ids.includes(id)) closePeer(id);
    }
    for (const id of ids) {
      void connectTo(id);
      const key = pairKey(uid, id);
      const offer = offers[key];
      const answer = answers[key];
      if (offer && offer.from === id) void handleOffer(id, offer);
      if (answer && answer.from === id) void handleAnswer(id, answer);
    }
  };

  const publishMembers = () => {
    input.onMembers(Object.entries(members).map(([id, row]) => ({
      uid: id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Guest',
      muted: Boolean(row.muted),
    })));
  };

  const join = async () => {
    if (closed || localStream) return Boolean(localStream);
    try {
      const existing = await getDoc(doc(db, 'rooms', voiceDocId(roomId)));
      const data = existing.exists() ? existing.data() : undefined;
      const raw = data?.members && typeof data.members === 'object'
        ? data.members as Record<string, unknown>
        : {};
      if (!raw[uid] && Object.keys(raw).length >= MAX_VOICE_PEERS) {
        input.onError('Voice chat is full (max 8).');
        return false;
      }
    } catch {
      // Join write will surface permission errors.
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    } catch {
      input.onError('Microphone permission is required for voice chat.');
      return false;
    }

    if (closed) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      return false;
    }

    unsub = onSnapshot(doc(db, 'rooms', voiceDocId(roomId)), (snap) => {
      if (closed) return;
      const data = snap.exists() ? snap.data() : {};
      members = data.members && typeof data.members === 'object' ? data.members as typeof members : {};
      offers = data.offers && typeof data.offers === 'object' ? data.offers as typeof offers : {};
      answers = data.answers && typeof data.answers === 'object' ? data.answers as typeof answers : {};
      const liveCount = Object.keys(members).length;
      if (!members[uid] && liveCount >= MAX_VOICE_PEERS) {
        input.onError('Voice chat is full (max 8).');
        leave();
        return;
      }
      publishMembers();
      if (localStream && members[uid]) syncPeers(members);
    });

    await patchVoice(roomId, {
      [`members.${uid}`]: { name, muted, joinedAt: Date.now() },
    });
    members = { ...members, [uid]: { name, muted } };
    publishMembers();
    return !closed && Boolean(localStream);
  };

  const setMuted = (next: boolean) => {
    muted = next;
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    if (localStream) {
      void patchVoice(roomId, { [`members.${uid}.muted`]: next, [`members.${uid}.name`]: name });
    }
  };

  const setName = (next: string) => {
    name = next;
    if (localStream) {
      void patchVoice(roomId, { [`members.${uid}.name`]: next, [`members.${uid}.muted`]: muted });
    }
  };

  const leave = () => {
    unsub?.();
    unsub = null;
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    for (const id of [...peers.keys()]) closePeer(id);
    const fields: Record<string, unknown> = {
      [`members.${uid}`]: deleteField(),
    };
    for (const key of Object.keys(offers)) {
      if (key.includes(uid)) fields[`offers.${key}`] = deleteField();
    }
    for (const key of Object.keys(answers)) {
      if (key.includes(uid)) fields[`answers.${key}`] = deleteField();
    }
    void patchVoice(roomId, fields);
    members = { ...members };
    delete members[uid];
    publishMembers();
  };

  const destroy = () => {
    closed = true;
    leave();
  };

  return { join, leave, setMuted, setName, destroy };
}
