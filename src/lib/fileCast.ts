import { deleteField, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { getRtcConfig } from './rtcConfig';

export const LOCAL_STREAM_URL = 'local-stream';
export const MAX_CAST_PEERS = 8;

const CHUNK_SIZE = 64 * 1024;
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 512 * 1024;

type SdpBlob = { type: 'offer' | 'answer'; sdp: string; from: string; gen?: number };
type IceBlob = { from: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

export function isLocalStreamUrl(url: string) {
  return url === LOCAL_STREAM_URL || url.startsWith('blob:');
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

function waitForBuffer(dc: RTCDataChannel) {
  if (dc.bufferedAmount <= BUFFER_LOW) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onLow = () => {
      dc.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.addEventListener('bufferedamountlow', onLow);
  });
}

async function sendFile(dc: RTCDataChannel, file: File, onProgress: (ratio: number) => void) {
  dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type || 'video/mp4' }));
  let offset = 0;
  while (offset < file.size && dc.readyState === 'open') {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    while (dc.readyState === 'open' && dc.bufferedAmount > BUFFER_HIGH) {
      await waitForBuffer(dc);
    }
    if (dc.readyState !== 'open') return;
    dc.send(buf);
    offset += buf.byteLength;
    onProgress(file.size ? offset / file.size : 1);
  }
  if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'done' }));
  onProgress(1);
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
  file?: File;
  onRemoteFile?: (file: Blob, name: string) => void;
  onProgress?: (ratio: number) => void;
  onError: (message: string) => void;
}): FileCastSession {
  const { roomId, uid, role } = input;
  const peers = new Map<string, RTCPeerConnection>();
  const makingOffer = new Set<string>();
  const appliedOffer = new Map<string, string>();
  const appliedAnswer = new Map<string, string>();
  const appliedCandidates = new Set<string>();
  const sendRatio = new Map<string, number>();
  const gen = Date.now();
  let unsub: (() => void) | null = null;
  let closed = false;
  let members: Record<string, { name?: string; role?: string }> = {};
  let offers: Record<string, SdpBlob> = {};
  let answers: Record<string, SdpBlob> = {};
  let candidates: Record<string, Record<string, IceBlob>> = {};

  const publishSendProgress = () => {
    if (role !== 'host' || !input.onProgress) return;
    const values = [...sendRatio.values()];
    if (!values.length) {
      input.onProgress(0);
      return;
    }
    input.onProgress(values.reduce((a, b) => a + b, 0) / values.length);
  };

  const closePeer = (peerUid: string) => {
    peers.get(peerUid)?.close();
    peers.delete(peerUid);
    makingOffer.delete(peerUid);
    appliedOffer.delete(peerUid);
    appliedAnswer.delete(peerUid);
    sendRatio.delete(peerUid);
    for (const mark of [...appliedCandidates]) {
      if (mark.startsWith(`${peerUid}:`)) appliedCandidates.delete(mark);
    }
  };

  const attachSender = (peerUid: string, dc: RTCDataChannel) => {
    if (role !== 'host' || !input.file) return;
    dc.binaryType = 'arraybuffer';
    const start = () => {
      void sendFile(dc, input.file!, (ratio) => {
        sendRatio.set(peerUid, ratio);
        publishSendProgress();
      }).catch((err) => {
        console.error(err);
        input.onError('Failed to send the file.');
      });
    };
    if (dc.readyState === 'open') start();
    else dc.onopen = start;
    dc.onerror = () => input.onError('File transfer interrupted.');
  };

  const attachReceiver = (dc: RTCDataChannel) => {
    if (role !== 'guest') return;
    dc.binaryType = 'arraybuffer';
    let expected = 0;
    let received = 0;
    let name = 'video';
    let mime = 'video/mp4';
    const parts: ArrayBuffer[] = [];
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as { type?: string; name?: string; size?: number; mime?: string };
          if (msg.type === 'meta') {
            expected = typeof msg.size === 'number' ? msg.size : 0;
            name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : 'video';
            mime = typeof msg.mime === 'string' && msg.mime ? msg.mime : 'video/mp4';
            received = 0;
            parts.length = 0;
            input.onProgress?.(0);
          } else if (msg.type === 'done') {
            input.onProgress?.(1);
            input.onRemoteFile?.(new Blob(parts, { type: mime }), name);
          }
        } catch {
          input.onError('Invalid file transfer message.');
        }
        return;
      }
      const buf = event.data instanceof ArrayBuffer
        ? event.data
        : event.data instanceof Blob
          ? null
          : null;
      if (buf) {
        parts.push(buf);
        received += buf.byteLength;
        if (expected > 0) input.onProgress?.(Math.min(1, received / expected));
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((ab) => {
          parts.push(ab);
          received += ab.byteLength;
          if (expected > 0) input.onProgress?.(Math.min(1, received / expected));
        });
      }
    };
  };

  const ensurePeer = (peerUid: string) => {
    let pc = peers.get(peerUid);
    if (pc) return pc;
    pc = new RTCPeerConnection(getRtcConfig());
    peers.set(peerUid, pc);
    if (role === 'host') {
      attachSender(peerUid, pc.createDataChannel('file', { ordered: true }));
    } else {
      pc.ondatachannel = (event) => attachReceiver(event.channel);
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
    if (closed || role !== 'host' || peerUid === uid || makingOffer.has(peerUid)) return;
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
      input.onError('Could not start the file transfer. Refresh and try again.');
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
    if (role === 'host' && !input.file) {
      input.onError('Choose a video file to share.');
      return false;
    }

    try {
      const existing = await getDoc(doc(db, 'rooms', castDocId(roomId)));
      const data = existing.exists() ? existing.data() : undefined;
      const raw = data?.members && typeof data.members === 'object'
        ? data.members as Record<string, unknown>
        : {};
      if (!raw[uid] && Object.keys(raw).length >= MAX_CAST_PEERS) {
        input.onError('Room file share is full (max 8).');
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
        input.onError('Room file share is full (max 8).');
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
