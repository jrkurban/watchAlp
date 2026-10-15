import { deleteField, doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { getRtcConfig } from './rtcConfig';

export const MAX_SCREEN_VIEWERS = 8;
const PRESENTER_TTL_MS = 25000;

export type ScreenShareInfo = {
  uid: string;
  name: string;
} | null;

type SdpBlob = { type: 'offer' | 'answer'; sdp: string; from: string };
type PresenterRow = { uid?: string; name?: string; heartbeat?: number };

export function screenDocId(roomId: string) {
  return `${roomId}__screen`;
}

function isPresenterFresh(row: PresenterRow | undefined): boolean {
  if (!row?.uid || typeof row.uid !== 'string') return false;
  const beat = typeof row.heartbeat === 'number' ? row.heartbeat : 0;
  return Date.now() - beat < PRESENTER_TTL_MS;
}

async function patchScreen(roomId: string, fields: Record<string, unknown>) {
  const ref = doc(db, 'rooms', screenDocId(roomId));
  const payload = {
    ...fields,
    currentVideoUrl: 'screen',
    updatedAt: new Date().toISOString(),
  };
  try {
    await updateDoc(ref, payload);
  } catch {
    await setDoc(ref, {
      currentVideoUrl: 'screen',
      updatedAt: payload.updatedAt,
      presenter: null,
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

export type ScreenShareSession = {
  watch: () => void;
  start: () => Promise<boolean>;
  stop: () => void;
  setName: (name: string) => void;
  destroy: () => void;
};

export function listenScreenShare(roomId: string, onPresenter: (info: ScreenShareInfo) => void) {
  return onSnapshot(doc(db, 'rooms', screenDocId(roomId)), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const row = data.presenter && typeof data.presenter === 'object' ? data.presenter as PresenterRow : undefined;
    if (!isPresenterFresh(row) || !row?.uid) {
      onPresenter(null);
      return;
    }
    onPresenter({
      uid: row.uid,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Guest',
    });
  }, () => onPresenter(null));
}

export function startScreenShareSession(input: {
  roomId: string;
  uid: string;
  name: string;
  onPresenter: (info: ScreenShareInfo) => void;
  onLocalStream: (stream: MediaStream | null) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onError: (message: string) => void;
}): ScreenShareSession {
  const { roomId, uid } = input;
  let name = input.name;
  const peers = new Map<string, RTCPeerConnection>();
  let localStream: MediaStream | null = null;
  let unsub: (() => void) | null = null;
  let heartbeat: number | null = null;
  let closed = false;
  let presenting = false;
  let presentUid = '';
  let offers: Record<string, SdpBlob> = {};
  let answers: Record<string, SdpBlob> = {};
  const makingOffer = new Set<string>();
  const answeredSdp = new Map<string, string>();

  const publishPresenter = (row: PresenterRow | undefined) => {
    if (!isPresenterFresh(row) || !row?.uid) {
      presentUid = '';
      input.onPresenter(null);
      return;
    }
    presentUid = row.uid;
    input.onPresenter({
      uid: row.uid,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Guest',
    });
  };

  const closePeer = (peerUid: string) => {
    peers.get(peerUid)?.close();
    peers.delete(peerUid);
    makingOffer.delete(peerUid);
    answeredSdp.delete(peerUid);
  };

  const closeAllPeers = () => {
    for (const id of [...peers.keys()]) closePeer(id);
  };

  const attachLocalTracks = (pc: RTCPeerConnection) => {
    localStream?.getTracks().forEach((track) => {
      if (!pc.getSenders().some((sender) => sender.track === track)) {
        pc.addTrack(track, localStream!);
      }
    });
  };

  const ensureViewerPeer = (viewerUid: string) => {
    let pc = peers.get(viewerUid);
    if (pc) return pc;
    pc = new RTCPeerConnection(getRtcConfig());
    peers.set(viewerUid, pc);
    attachLocalTracks(pc);
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeer(viewerUid);
      }
    };
    return pc;
  };

  const handleOffer = async (viewerUid: string, offer: SdpBlob) => {
    if (closed || !presenting || !localStream || offer.from !== viewerUid) return;
    if (answeredSdp.get(viewerUid) === offer.sdp) return;
    answeredSdp.set(viewerUid, offer.sdp);
    closePeer(viewerUid);
    answeredSdp.set(viewerUid, offer.sdp);
    try {
      const pc = ensureViewerPeer(viewerUid);
      if (pc.signalingState !== 'stable') return;
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchScreen(roomId, {
        [`answers.${viewerUid}`]: { type: 'answer', sdp: local.sdp, from: uid },
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleAnswer = async (answer: SdpBlob) => {
    const pc = peers.get('presenter');
    if (!pc || answer.from === uid || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (err) {
      console.error(err);
    }
  };

  const connectAsViewer = async (presenterId: string) => {
    if (closed || presenting || presenterId === uid || makingOffer.has('presenter')) return;
    const existing = peers.get('presenter');
    if (existing && (existing.currentRemoteDescription || existing.signalingState !== 'stable')) return;
    makingOffer.add('presenter');
    try {
      closePeer('presenter');
      const pc = new RTCPeerConnection(getRtcConfig());
      peers.set('presenter', pc);
      const remote = new MediaStream();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (event) => {
        if (event.track) remote.addTrack(event.track);
        input.onRemoteStream(remote);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          closePeer('presenter');
          input.onRemoteStream(null);
          window.setTimeout(() => {
            if (!closed && presentUid && presentUid !== uid) void connectAsViewer(presentUid);
          }, 1200);
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      const local = pc.localDescription;
      if (!local?.sdp || closed) return;
      await patchScreen(roomId, {
        [`offers.${uid}`]: { type: 'offer', sdp: local.sdp, from: uid },
        [`answers.${uid}`]: deleteField(),
      });
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer.delete('presenter');
    }
  };

  const leaveAsViewer = () => {
    const hadSession = peers.has('presenter') || Boolean(offers[uid] || answers[uid]);
    closePeer('presenter');
    input.onRemoteStream(null);
    if (!hadSession) return;
    void patchScreen(roomId, {
      [`offers.${uid}`]: deleteField(),
      [`answers.${uid}`]: deleteField(),
    });
  };

  const stopPresenting = () => {
    const wasPresenting = presenting;
    presenting = false;
    if (heartbeat) {
      window.clearInterval(heartbeat);
      heartbeat = null;
    }
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    input.onLocalStream(null);
    closeAllPeers();
    if (!wasPresenting) return;
    const fields: Record<string, unknown> = {
      presenter: deleteField(),
    };
    for (const key of Object.keys(offers)) fields[`offers.${key}`] = deleteField();
    for (const key of Object.keys(answers)) fields[`answers.${key}`] = deleteField();
    void patchScreen(roomId, fields);
  };

  const onSnap = (presenter: PresenterRow | undefined, nextOffers: Record<string, SdpBlob>, nextAnswers: Record<string, SdpBlob>) => {
    offers = nextOffers;
    answers = nextAnswers;
    const live = isPresenterFresh(presenter) ? presenter : undefined;
    publishPresenter(live);

    if (presenting) {
      const viewerIds = Object.keys(nextOffers);
      for (const id of [...peers.keys()]) {
        if (!viewerIds.includes(id)) closePeer(id);
      }
      for (const [viewerUid, offer] of Object.entries(nextOffers).slice(0, MAX_SCREEN_VIEWERS)) {
        if (offer?.from === viewerUid) void handleOffer(viewerUid, offer);
      }
      return;
    }

    if (!live?.uid || live.uid === uid) {
      leaveAsViewer();
      return;
    }
    const offerCount = Object.keys(nextOffers).length;
    if (!nextOffers[uid] && offerCount >= MAX_SCREEN_VIEWERS) {
      input.onError('Screen share is full (max 8 viewers).');
      return;
    }
    if (!peers.has('presenter')) void connectAsViewer(live.uid);
    const answer = nextAnswers[uid];
    if (answer && answer.from === live.uid) void handleAnswer(answer);
  };

  const watch = () => {
    if (closed || unsub) return;
    unsub = onSnapshot(doc(db, 'rooms', screenDocId(roomId)), (snap) => {
      if (closed) return;
      const data = snap.exists() ? snap.data() : {};
      const presenter = data.presenter && typeof data.presenter === 'object' ? data.presenter as PresenterRow : undefined;
      const nextOffers = data.offers && typeof data.offers === 'object' ? data.offers as Record<string, SdpBlob> : {};
      const nextAnswers = data.answers && typeof data.answers === 'object' ? data.answers as Record<string, SdpBlob> : {};
      onSnap(presenter, nextOffers, nextAnswers);
    }, () => {
      if (!closed) input.onPresenter(null);
    });
  };

  const start = async () => {
    if (closed || presenting) return presenting;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      input.onError('Screen share is not available in this browser.');
      return false;
    }
    if (presentUid && presentUid !== uid) {
      input.onError('Someone is already sharing their screen.');
      return false;
    }

    const displayOptions: DisplayMediaStreamOptions = {
      video: {
        frameRate: { ideal: 15, max: 24 },
        width: { max: 1920 },
        height: { max: 1080 },
      },
      audio: true,
    };
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
    } catch {
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ ...displayOptions, audio: false });
      } catch {
        input.onError('Screen share permission was denied.');
        return false;
      }
    }

    if (closed) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      return false;
    }

    leaveAsViewer();
    presenting = true;
    localStream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (presenting) stopPresenting();
      });
    });
    input.onLocalStream(localStream);

    const beat = () => {
      void patchScreen(roomId, {
        presenter: { uid, name, heartbeat: Date.now() },
      });
    };
    void patchScreen(roomId, {
      presenter: { uid, name, heartbeat: Date.now() },
      offers: {},
      answers: {},
    });
    heartbeat = window.setInterval(beat, 8000);
    return true;
  };

  const stop = () => {
    if (presenting) stopPresenting();
  };

  const setName = (next: string) => {
    name = next;
    if (presenting) {
      void patchScreen(roomId, {
        presenter: { uid, name, heartbeat: Date.now() },
      });
    }
  };

  const destroy = () => {
    closed = true;
    unsub?.();
    unsub = null;
    if (presenting) stopPresenting();
    else leaveAsViewer();
  };

  return { watch, start, stop, setName, destroy };
}
