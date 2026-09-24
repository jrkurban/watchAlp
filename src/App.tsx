import React, { useState, useEffect, useRef, useMemo, SyntheticEvent } from 'react';
import ReactPlayer from './lib/watchPlayer';
import { io, Socket } from 'socket.io-client';
import { Play, Link, Users, Video, Copy, Check, Upload, Trash2, List, X, Sun, Moon, Pencil, Shield, Cast } from 'lucide-react';
import { initAuth, db, storage } from './lib/firebase';
import { deleteField, doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject, listAll, uploadBytes } from 'firebase/storage';
import { Chat } from './components/Chat';
import { MediaTrackBar } from './components/MediaTrackBar';
import { RoomMembers } from './components/RoomMembers';
import { VoiceBar } from './components/VoiceBar';
import { startVisitorSession } from './lib/visitorSession';
import { getStoredUsername, saveUsername, USERNAME_MAX } from './lib/identity';
import {
  hasAnyAdmin,
  isUidAdmin,
  isUidBanned,
  parseBannedUsers,
  parseRoomMembers,
  shouldClaimRoomAdmin,
  type BannedUser,
  type RoomMember,
} from './lib/roomRoles';
import {
  listenVoiceMembers,
  startVoiceSession,
  type VoiceMember,
  type VoiceSession,
} from './lib/voiceChat';
import {
  captureVideoStream,
  LOCAL_STREAM_URL,
  startFileCast,
  type FileCastSession,
} from './lib/fileCast';
import {
  type CaptionTrack,
  type ExtraAudioTrack,
  getHtmlVideo,
  isUploadedVideo,
  labelFromFilename,
  langFromFilename,
  mediaKeyFromUrl,
  parseTrackMap,
  probeSidecarCaptions,
  toWebVtt,
} from './lib/mediaTracks';

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const SYNC_INTERVAL_MS = 3000;
const PRESENCE_TTL_MS = 25000;

interface VideoFile {
  name: string;
  url: string;
  path: string;
}

interface RoomState {
  url?: string;
  time: number;
  playing: boolean;
}

interface MediaLike {
  currentTime: number;
  paused?: boolean;
  play?: () => Promise<void> | void;
}

function readOrCreateRoomId(): string {
  const existing = new URLSearchParams(window.location.search).get('room')?.trim();
  if (existing) return existing;
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function getMedia(node: HTMLElement | null): MediaLike | null {
  if (!node) return null;
  const candidate = 'currentTime' in node
    ? node
    : node.querySelector('video, youtube-video, vimeo-video, wistia-video');
  if (!candidate || typeof (candidate as unknown as MediaLike).currentTime !== 'number') return null;
  return candidate as unknown as MediaLike;
}

export default function App() {
  const [roomId] = useState(readOrCreateRoomId);
  const [url, setUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [playing, setPlaying] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [uid, setUid] = useState('');
  const [userCount, setUserCount] = useState(1);
  const [copied, setCopied] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedVideos, setUploadedVideos] = useState<VideoFile[]>([]);
  const [showVideoList, setShowVideoList] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark';
  });
  const [socket, setSocket] = useState<Socket | null>(null);
  const [displayName, setDisplayName] = useState(getStoredUsername);
  const [nameDraft, setNameDraft] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isAdmin, setIsAdmin] = useState(shouldClaimRoomAdmin(roomId));
  const [isBanned, setIsBanned] = useState(false);
  const [ownerUid, setOwnerUid] = useState('');
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([]);
  const [showPeople, setShowPeople] = useState(false);
  const [viewerNames, setViewerNames] = useState<string[]>([]);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [inVoice, setInVoice] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceJoining, setVoiceJoining] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [castTitle, setCastTitle] = useState('');
  const [castError, setCastError] = useState<string | null>(null);
  const [remoteCastStream, setRemoteCastStream] = useState<MediaStream | null>(null);
  const [isCastHost, setIsCastHost] = useState(false);
  const [captionTracks, setCaptionTracks] = useState<CaptionTrack[]>([]);
  const [detectedCaptions, setDetectedCaptions] = useState<CaptionTrack[]>([]);
  const [extraAudioTracks, setExtraAudioTracks] = useState<ExtraAudioTrack[]>([]);
  const [selectedCaptionId, setSelectedCaptionId] = useState('');
  const [selectedAudioId, setSelectedAudioId] = useState('default');
  const [playerReadyTick, setPlayerReadyTick] = useState(0);
  const [captionSrcById, setCaptionSrcById] = useState<Record<string, string>>({});

  const playerRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const playingRef = useRef(false);
  const urlRef = useRef('');
  const uidRef = useRef('');
  const displayNameRef = useRef(displayName);
  const ignoreNextPlayPause = useRef(false);
  const ignoreSeekUntil = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamInputRef = useRef<HTMLInputElement>(null);
  const remoteCastRef = useRef<HTMLVideoElement | null>(null);
  const lastPlayedSeconds = useRef(0);
  const lastSyncSentAt = useRef(0);
  const pendingSync = useRef<{ time: number; playing: boolean } | null>(null);
  const applyRemotePlaybackRef = useRef<(time: number, nextPlaying?: boolean) => void>(() => {});
  const adminClaimedRef = useRef(false);
  const isBannedRef = useRef(false);
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  const fileCastRef = useRef<FileCastSession | null>(null);
  const isCastHostRef = useRef(false);
  const localBlobUrlRef = useRef('');

  playingRef.current = playing;
  urlRef.current = url;
  uidRef.current = uid;
  displayNameRef.current = displayName;
  isBannedRef.current = isBanned;

  const seekMedia = (time: number) => {
    const media = getMedia(playerRef.current);
    if (!media) return false;
    media.currentTime = time;
    lastPlayedSeconds.current = time;
    return true;
  };

  const applyRemotePlayback = (time: number, nextPlaying?: boolean) => {
    ignoreNextPlayPause.current = true;
    ignoreSeekUntil.current = Date.now() + 1200;
    window.setTimeout(() => {
      ignoreNextPlayPause.current = false;
    }, 600);

    if (typeof nextPlaying === 'boolean') {
      setPlaying(nextPlaying);
    }

    if (seekMedia(time)) {
      pendingSync.current = null;
      if (nextPlaying) {
        window.setTimeout(() => {
          const media = getMedia(playerRef.current);
          if (playingRef.current && media?.paused) setNeedsUnlock(true);
        }, 700);
      }
    } else {
      pendingSync.current = {
        time,
        playing: nextPlaying ?? playingRef.current,
      };
    }
  };

  applyRemotePlaybackRef.current = applyRemotePlayback;

  const applyPendingSync = () => {
    const pending = pendingSync.current;
    if (!pending) return;
    ignoreNextPlayPause.current = true;
    ignoreSeekUntil.current = Date.now() + 1200;
    if (seekMedia(pending.time)) {
      setPlaying(pending.playing);
      pendingSync.current = null;
    }
    window.setTimeout(() => {
      ignoreNextPlayPause.current = false;
    }, 600);
  };

  const writePlayback = async (patch: { playing?: boolean; time?: number; currentVideoUrl?: string; streamTitle?: string }) => {
    if (!uidRef.current || isBannedRef.current) return;
    try {
      await setDoc(doc(db, 'rooms', roomId), {
        currentVideoUrl: patch.currentVideoUrl
          ?? (isCastHostRef.current ? LOCAL_STREAM_URL : urlRef.current),
        playing: patch.playing ?? playingRef.current,
        time: patch.time ?? lastPlayedSeconds.current,
        playbackUpdatedAt: Date.now(),
        playbackUpdatedBy: uidRef.current,
        updatedAt: new Date().toISOString(),
        ...(patch.streamTitle !== undefined ? { streamTitle: patch.streamTitle } : {}),
      }, { merge: true });
    } catch (err) {
      console.error('Failed to write playback state', err);
    }
  };

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('room') === roomId) return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('room', roomId);
    window.history.replaceState({}, '', nextUrl);
  }, [roomId]);

  useEffect(() => {
    return startVisitorSession(roomId);
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    let unsubRoom: (() => void) | undefined;
    const unsubAuth = getAuth().onAuthStateChanged((user) => {
      if (!cancelled) setUid(user?.uid ?? '');
    });

    initAuth().then((ready) => {
      if (cancelled) return;
      setIsAuthReady(ready);
      if (!ready) return;
      unsubRoom = onSnapshot(doc(db, 'rooms', roomId), (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();
        const liveUid = getAuth().currentUser?.uid || uidRef.current;
        if (liveUid) uidRef.current = liveUid;
        if (typeof data.currentVideoUrl === 'string') {
          if (data.currentVideoUrl === LOCAL_STREAM_URL) {
            if (!isCastHostRef.current) setUrl(LOCAL_STREAM_URL);
            if (typeof data.streamTitle === 'string') setCastTitle(data.streamTitle);
          } else {
            setUrl((prevUrl) => (prevUrl !== data.currentVideoUrl ? data.currentVideoUrl : prevUrl));
          }
        }

        const mediaKey = mediaKeyFromUrl(typeof data.currentVideoUrl === 'string' ? data.currentVideoUrl : urlRef.current);
        const bucket = data.videoTracks && typeof data.videoTracks === 'object'
          ? (data.videoTracks as Record<string, { captions?: unknown; audio?: unknown }>)[mediaKey]
          : undefined;
        setCaptionTracks(parseTrackMap<CaptionTrack>(bucket?.captions));
        setExtraAudioTracks(parseTrackMap<ExtraAudioTrack>(bucket?.audio));

        const beats = data.viewerHeartbeats;
        const names = data.viewerNames;
        const liveOwner = typeof data.ownerUid === 'string' ? data.ownerUid : '';
        setOwnerUid(liveOwner);
        const banned = isUidBanned(data.bannedUsers, liveUid);
        setIsBanned(banned);
        setBannedUsers(parseBannedUsers(data.bannedUsers));
        const nextMembers = parseRoomMembers({
          heartbeats: beats,
          names,
          adminUids: data.adminUids,
          bannedUsers: data.bannedUsers,
          ownerUid: liveOwner,
          selfUid: liveUid,
          selfName: displayNameRef.current,
          now: Date.now(),
          onlineMs: PRESENCE_TTL_MS,
        });
        setMembers(nextMembers);
        setUserCount(Math.max(1, nextMembers.filter((member) => member.online).length || 1));
        setViewerNames(nextMembers.filter((member) => member.online).map((member) => member.name));

        if (banned) {
          setIsAdmin(false);
        } else if (isUidAdmin(data.adminUids, liveUid) || liveOwner === liveUid || shouldClaimRoomAdmin(roomId)) {
          setIsAdmin(true);
        } else {
          setIsAdmin(false);
        }

        if (!banned && liveUid && !adminClaimedRef.current && (!hasAnyAdmin(data.adminUids) || shouldClaimRoomAdmin(roomId))) {
          adminClaimedRef.current = true;
          setIsAdmin(true);
          const claim: Record<string, unknown> = {
            [`adminUids.${liveUid}`]: true,
            currentVideoUrl: urlRef.current || '',
          };
          if (!liveOwner) claim.ownerUid = liveUid;
          updateDoc(doc(db, 'rooms', roomId), claim).catch(() => {
            setDoc(doc(db, 'rooms', roomId), {
              currentVideoUrl: urlRef.current || '',
              adminUids: { [liveUid]: true },
              ...(liveOwner ? {} : { ownerUid: liveUid }),
            }, { merge: true }).catch(() => {
              adminClaimedRef.current = false;
            });
          });
        }

        if (banned) return;
        if (data.playbackUpdatedBy && data.playbackUpdatedBy === uidRef.current) return;
        if (typeof data.time !== 'number') return;

        const localTime = getMedia(playerRef.current)?.currentTime ?? lastPlayedSeconds.current;
        const playingChanged = typeof data.playing === 'boolean' && data.playing !== playingRef.current;
        if (playingChanged || Math.abs(data.time - localTime) > 1.5) {
          applyRemotePlaybackRef.current(data.time, Boolean(data.playing));
        }
      });
    });

    const nextSocket = io({
      reconnection: true,
    });
    socketRef.current = nextSocket;
    setSocket(nextSocket);

    nextSocket.on('connect', () => {
      nextSocket.emit('joinRoom', roomId);
    });

    nextSocket.on('room-users', (count: number) => {
      if (typeof count === 'number') {
        setUserCount((prev) => Math.max(prev, count));
      }
    });

    nextSocket.on('roomState', (state: RoomState) => {
      if (typeof state.url === 'string') setUrl(state.url);
      applyRemotePlaybackRef.current(state.time ?? 0, Boolean(state.playing));
    });

    nextSocket.on('video-play', (time: number) => {
      applyRemotePlaybackRef.current(time, true);
    });

    nextSocket.on('video-pause', (time: number) => {
      applyRemotePlaybackRef.current(time, false);
    });

    nextSocket.on('seek', (time: number) => {
      applyRemotePlaybackRef.current(time);
    });

    nextSocket.on('videoStateUpdate', (state: { url?: string }) => {
      if (typeof state?.url === 'string') {
        setUrl(state.url);
        setPlaying(false);
        lastPlayedSeconds.current = 0;
      }
    });

    return () => {
      cancelled = true;
      unsubAuth();
      unsubRoom?.();
      nextSocket.removeAllListeners();
      nextSocket.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [roomId]);

  useEffect(() => {
    if (!uid || !isAuthReady || isBanned) return;
    const roomRef = doc(db, 'rooms', roomId);
    const pulse = async () => {
      const claimAdmin = shouldClaimRoomAdmin(roomId);
      const patch: Record<string, unknown> = {
        [`viewerHeartbeats.${uid}`]: Date.now(),
        [`viewerNames.${uid}`]: displayNameRef.current,
      };
      if (claimAdmin) {
        patch[`adminUids.${uid}`] = true;
        if (!ownerUid) patch.ownerUid = uid;
      }
      try {
        await updateDoc(roomRef, patch);
      } catch {
        await setDoc(roomRef, {
          currentVideoUrl: urlRef.current || '',
          viewerHeartbeats: { [uid]: Date.now() },
          viewerNames: { [uid]: displayNameRef.current },
          ...(claimAdmin ? { adminUids: { [uid]: true }, ownerUid: ownerUid || uid } : {}),
        }, { merge: true });
      }
    };
    pulse();
    const interval = window.setInterval(pulse, 8000);
    return () => {
      window.clearInterval(interval);
      updateDoc(roomRef, {
        [`viewerHeartbeats.${uid}`]: deleteField(),
        [`viewerNames.${uid}`]: deleteField(),
      }).catch(() => {});
    };
  }, [uid, roomId, isAuthReady, isBanned, ownerUid]);

  useEffect(() => {
    if (!isAuthReady) return;
    return listenVoiceMembers(roomId, setVoiceMembers);
  }, [roomId, isAuthReady]);

  useEffect(() => {
    voiceSessionRef.current?.setName(displayName);
  }, [displayName]);

  useEffect(() => {
    if (!isBanned && uid) return;
    voiceSessionRef.current?.destroy();
    voiceSessionRef.current = null;
    setInVoice(false);
    setVoiceJoining(false);
    setVoiceMuted(false);
  }, [isBanned, uid]);

  useEffect(() => () => {
    voiceSessionRef.current?.destroy();
    voiceSessionRef.current = null;
  }, [roomId]);

  const joinVoice = async () => {
    if (!uid || isBanned || inVoice || voiceJoining) return;
    setVoiceError(null);
    setVoiceJoining(true);
    voiceSessionRef.current?.destroy();
    const session = startVoiceSession({
      roomId,
      uid,
      name: displayNameRef.current,
      onMembers: setVoiceMembers,
      onError: (message) => {
        setVoiceError(message);
        setInVoice(false);
        setVoiceJoining(false);
      },
    });
    voiceSessionRef.current = session;
    const ok = await session.join();
    setVoiceJoining(false);
    if (ok && voiceSessionRef.current === session) {
      setInVoice(true);
    } else if (voiceSessionRef.current === session) {
      session.destroy();
      voiceSessionRef.current = null;
      setInVoice(false);
    }
  };

  const leaveVoice = () => {
    voiceSessionRef.current?.destroy();
    voiceSessionRef.current = null;
    setInVoice(false);
    setVoiceJoining(false);
    setVoiceMuted(false);
    setVoiceError(null);
  };

  const toggleVoiceMute = () => {
    const next = !voiceMuted;
    setVoiceMuted(next);
    voiceSessionRef.current?.setMuted(next);
  };

  const stopLocalCast = () => {
    fileCastRef.current?.destroy();
    fileCastRef.current = null;
    isCastHostRef.current = false;
    setIsCastHost(false);
    setRemoteCastStream(null);
    setCastError(null);
    if (localBlobUrlRef.current) {
      URL.revokeObjectURL(localBlobUrlRef.current);
      localBlobUrlRef.current = '';
    }
    setCastTitle('');
  };

  const startHostCastFromPlayer = () => {
    if (!isCastHostRef.current || fileCastRef.current || !uidRef.current) return;
    let tries = 0;
    const attempt = () => {
      if (!isCastHostRef.current || fileCastRef.current) return;
      const video = getHtmlVideo(playerRef.current)
        ?? (playerRef.current instanceof HTMLVideoElement ? playerRef.current : null);
      const stream = video ? captureVideoStream(video) : null;
      if (!stream) {
        tries += 1;
        if (tries < 12) {
          window.setTimeout(attempt, 250);
          return;
        }
        setCastError('This browser cannot stream a local file. Try Chrome or Edge.');
        return;
      }
      const session = startFileCast({
        roomId,
        uid: uidRef.current,
        name: displayNameRef.current,
        role: 'host',
        stream,
        onError: setCastError,
      });
      fileCastRef.current = session;
      void session.join();
    };
    attempt();
  };

  useEffect(() => {
    if (!uid || !isAuthReady || isBanned || isCastHost || url !== LOCAL_STREAM_URL) return;
    const session = startFileCast({
      roomId,
      uid,
      name: displayNameRef.current,
      role: 'guest',
      onRemoteStream: setRemoteCastStream,
      onError: setCastError,
    });
    fileCastRef.current = session;
    void session.join();
    return () => {
      session.destroy();
      if (fileCastRef.current === session) fileCastRef.current = null;
      setRemoteCastStream(null);
    };
  }, [uid, roomId, isAuthReady, isBanned, isCastHost, url]);

  useEffect(() => {
    const el = remoteCastRef.current;
    if (!el) return;
    if (el.srcObject !== remoteCastStream) el.srcObject = remoteCastStream;
    if (remoteCastStream) {
      el.autoplay = true;
      el.playsInline = true;
      void el.play().catch(() => setNeedsUnlock(true));
    }
  }, [remoteCastStream, url, isCastHost]);

  useEffect(() => {
    if (!isBanned) return;
    fileCastRef.current?.destroy();
    fileCastRef.current = null;
  }, [isBanned]);

  useEffect(() => () => {
    fileCastRef.current?.destroy();
    fileCastRef.current = null;
    if (localBlobUrlRef.current) URL.revokeObjectURL(localBlobUrlRef.current);
  }, [roomId]);

  const handlePlay = () => {
    setNeedsUnlock(false);
    if (ignoreNextPlayPause.current) {
      ignoreNextPlayPause.current = false;
      return;
    }
    setPlaying(true);
    const time = getMedia(playerRef.current)?.currentTime ?? lastPlayedSeconds.current;
    lastPlayedSeconds.current = time;
    socketRef.current?.emit('video-play', { roomId, time });
    writePlayback({ playing: true, time });
  };

  const handlePause = () => {
    if (ignoreNextPlayPause.current) {
      ignoreNextPlayPause.current = false;
      return;
    }
    setPlaying(false);
    const time = getMedia(playerRef.current)?.currentTime ?? lastPlayedSeconds.current;
    lastPlayedSeconds.current = time;
    socketRef.current?.emit('video-pause', { roomId, time });
    writePlayback({ playing: false, time });
  };

  const handleTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    const playedSeconds = event.currentTarget.currentTime;
    if (Date.now() < ignoreSeekUntil.current) {
      lastPlayedSeconds.current = playedSeconds;
      return;
    }

    if (Math.abs(playedSeconds - lastPlayedSeconds.current) > 1.5) {
      socketRef.current?.emit('seek', { roomId, time: playedSeconds });
      writePlayback({ time: playedSeconds });
    }

    lastPlayedSeconds.current = playedSeconds;

    const now = Date.now();
    if (now - lastSyncSentAt.current >= SYNC_INTERVAL_MS) {
      lastSyncSentAt.current = now;
      socketRef.current?.emit('video-sync', {
        roomId,
        time: playedSeconds,
        playing: playingRef.current,
      });
      writePlayback({ time: playedSeconds, playing: playingRef.current });
    }
  };

  const handleSeeked = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (Date.now() < ignoreSeekUntil.current) return;
    const time = event.currentTarget.currentTime;
    lastPlayedSeconds.current = time;
    socketRef.current?.emit('seek', { roomId, time });
    writePlayback({ time });
  };

  const updateRoomState = async (newUrl: string) => {
    if (!isAdmin) return;
    if (newUrl !== LOCAL_STREAM_URL) stopLocalCast();
    setUrl(newUrl);
    setPlaying(false);
    lastPlayedSeconds.current = 0;
    socketRef.current?.emit('videoStateUpdate', { roomId, state: { url: newUrl } });
    await writePlayback({ currentVideoUrl: newUrl, playing: false, time: 0 });
  };

  useEffect(() => {
    setSelectedCaptionId('');
    setSelectedAudioId('default');
    setDetectedCaptions([]);
    if (!url || !isUploadedVideo(url)) return;
    let cancelled = false;
    probeSidecarCaptions(url).then((rows) => {
      if (!cancelled) setDetectedCaptions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const playableCaptions = useMemo(
    () => [...detectedCaptions, ...captionTracks],
    [detectedCaptions, captionTracks],
  );

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const track of playableCaptions) {
      if (track.vtt) next[track.id] = URL.createObjectURL(new Blob([track.vtt], { type: 'text/vtt' }));
      else if (track.url) next[track.id] = track.url;
    }
    setCaptionSrcById(next);
    return () => {
      for (const src of Object.values(next)) {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      }
    };
  }, [playableCaptions]);

  const handleCaptionUpload = async (file: File) => {
    if (!isAdmin || !isUploadedVideo(url)) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Subtitle file is too large (max 5 MB).');
      return;
    }
    try {
      const vtt = toWebVtt(await file.text());
      if (vtt.length > 350_000) {
        alert('Subtitle file is too large to store.');
        return;
      }
      const id = crypto.randomUUID().slice(0, 8);
      const mediaKey = mediaKeyFromUrl(url);
      const record: CaptionTrack = {
        id,
        label: labelFromFilename(file.name),
        lang: langFromFilename(file.name),
        vtt,
      };
      await updateDoc(doc(db, 'rooms', roomId), {
        [`videoTracks.${mediaKey}.captions.${id}`]: record,
        currentVideoUrl: url,
        updatedAt: new Date().toISOString(),
      });
      setSelectedCaptionId(id);
    } catch (err) {
      console.error(err);
      alert('Failed to upload subtitles.');
    }
  };

  const handleAudioTrackUpload = async (file: File) => {
    if (!isAdmin || !isUploadedVideo(url)) return;
    if (!file.type.startsWith('audio/')) {
      alert('Please choose an audio file.');
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      alert('Audio file is too large (max 200 MB).');
      return;
    }
    try {
      const id = crypto.randomUUID().slice(0, 8);
      const mediaKey = mediaKeyFromUrl(url);
      const safeName = file.name.replace(/[^\w.\-]+/g, '_');
      const path = `rooms/${roomId}/audio/${mediaKey}/${id}_${safeName}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file, { contentType: file.type || 'audio/mpeg' });
      const downloadUrl = await getDownloadURL(storageRef);
      const record: ExtraAudioTrack = {
        id,
        label: labelFromFilename(file.name),
        url: downloadUrl,
        path,
      };
      await updateDoc(doc(db, 'rooms', roomId), {
        [`videoTracks.${mediaKey}.audio.${id}`]: record,
        currentVideoUrl: url,
        updatedAt: new Date().toISOString(),
      });
      setSelectedAudioId(`file:${id}`);
    } catch (err) {
      console.error(err);
      alert('Failed to upload audio.');
    }
  };

  const commitDisplayName = (value: string) => {
    const next = saveUsername(value);
    setDisplayName(next);
    setNameDraft(next);
    setIsEditingName(false);
    if (!uid) return;
    updateDoc(doc(db, 'rooms', roomId), { [`viewerNames.${uid}`]: next }).catch(() => {});
  };

  const patchRoom = (fields: Record<string, unknown>) =>
    updateDoc(doc(db, 'rooms', roomId), {
      ...fields,
      currentVideoUrl: urlRef.current || url || '',
      updatedAt: new Date().toISOString(),
    });

  const grantAdmin = (targetUid: string) => {
    if (!isAdmin) return;
    void patchRoom({ [`adminUids.${targetUid}`]: true });
  };

  const revokeAdmin = (targetUid: string) => {
    if (!isAdmin || targetUid === ownerUid || targetUid === uid) return;
    void patchRoom({ [`adminUids.${targetUid}`]: deleteField() });
  };

  const banMember = (member: RoomMember) => {
    if (!isAdmin || member.uid === uid || member.isOwner) return;
    if (!window.confirm(`Ban ${member.name} from this room?`)) return;
    void patchRoom({
      [`bannedUsers.${member.uid}`]: { name: member.name, at: Date.now() },
      [`adminUids.${member.uid}`]: deleteField(),
      [`viewerHeartbeats.${member.uid}`]: deleteField(),
      [`viewerNames.${member.uid}`]: deleteField(),
    });
  };

  const unbanUser = (targetUid: string) => {
    if (!isAdmin) return;
    void patchRoom({ [`bannedUsers.${targetUid}`]: deleteField() });
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (inputUrl.trim()) {
      updateRoomState(inputUrl.trim());
      setInputUrl('');
    }
  };

  const handleLocalStreamFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdmin) {
      e.target.value = '';
      return;
    }
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      alert('Please choose a video file.');
      return;
    }
    stopLocalCast();
    const blobUrl = URL.createObjectURL(file);
    isCastHostRef.current = true;
    setIsCastHost(true);
    localBlobUrlRef.current = blobUrl;
    setCastTitle(file.name);
    setCastError(null);
    setUrl(blobUrl);
    setPlaying(true);
    lastPlayedSeconds.current = 0;
    socketRef.current?.emit('videoStateUpdate', { roomId, state: { url: LOCAL_STREAM_URL } });
    void writePlayback({ currentVideoUrl: LOCAL_STREAM_URL, playing: true, time: 0, streamTitle: file.name });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdmin) {
      e.target.value = '';
      return;
    }
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('video/')) {
      alert('Please choose a video file.');
      e.target.value = '';
      return;
    }

    if (file.size > MAX_VIDEO_BYTES) {
      alert('Video is too large (max 2 GB).');
      e.target.value = '';
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    const storageRef = ref(storage, `rooms/${roomId}/${Date.now()}_${file.name}`);
    const metadata = { contentType: file.type || 'video/mp4' };
    const uploadTask = uploadBytesResumable(storageRef, file, metadata);

    uploadTask.on('state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        setUploadProgress(Math.round(progress));
      },
      (error) => {
        console.error('Upload failed:', error);
        alert(`Failed to upload video: ${error.message}`);
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          await updateRoomState(downloadUrl);
        } catch (error: any) {
          console.error('Error setting video URL', error);
          alert(`Failed to finish upload: ${error.message}`);
        } finally {
          setIsUploading(false);
          setUploadProgress(0);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      }
    );
  };

  const handleClearVideo = async () => {
    if (!isAdmin || !url) return;
    if (!window.confirm('Remove the current video from this room?')) return;

    if (url.includes('firebasestorage')) {
      try {
        const storageRef = ref(storage, url);
        await deleteObject(storageRef);
      } catch (err) {
        console.error('Failed to delete from storage', err);
      }
    }
    await updateRoomState('');
  };

  const fetchUploadedVideos = async () => {
    try {
      const folderRef = ref(storage, `rooms/${roomId}`);
      const res = await listAll(folderRef);

      const videos = await Promise.all(res.items.map(async (itemRef) => {
        const downloadUrl = await getDownloadURL(itemRef);
        return {
          name: itemRef.name,
          url: downloadUrl,
          path: itemRef.fullPath
        };
      }));

      setUploadedVideos(videos);
    } catch (err) {
      console.error('Failed to fetch uploaded videos', err);
    }
  };

  useEffect(() => {
    if (showVideoList && isAuthReady) {
      fetchUploadedVideos();
    }
  }, [showVideoList, roomId, isAuthReady]);

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-sans selection:bg-stone-200 dark:selection:bg-stone-700 transition-colors duration-200">
      <header className="bg-white dark:bg-stone-950 border-b border-stone-200 dark:border-stone-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm transition-colors duration-200">
        <a href="/" className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-sm">
                <Video className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-stone-800 dark:text-stone-100">Apeiron Watch</h1>
        </a>

        <div className="flex items-center gap-3">
            {isEditingName ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  commitDisplayName(nameDraft);
                }}
              >
                <input
                  autoFocus
                  value={nameDraft}
                  maxLength={USERNAME_MAX}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="w-36 md:w-44 bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg px-3 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  className="p-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500"
                  title="Save username"
                >
                  <Check className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(displayName);
                  setIsEditingName(true);
                }}
                className="flex items-center gap-2 bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 px-3 py-1.5 rounded-lg hover:bg-stone-200 dark:hover:bg-stone-700 transition-colors"
                title="Change username"
              >
                <span className="text-sm font-semibold truncate max-w-[9rem] md:max-w-[12rem]">{displayName}</span>
                {isAdmin ? <Shield className="w-3.5 h-3.5 text-indigo-500" /> : null}
                <Pencil className="w-3.5 h-3.5 text-stone-400" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowPeople(true)}
              className="flex items-center gap-2 bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 px-3 py-1.5 rounded-lg hover:bg-stone-200 dark:hover:bg-stone-700 transition-colors"
              title="People in this room"
            >
                <Users className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span className="text-sm font-semibold tabular-nums">{userCount}</span>
                <span className="text-sm font-medium">online</span>
            </button>
            <VoiceBar
              inVoice={inVoice}
              muted={voiceMuted}
              joining={voiceJoining}
              members={voiceMembers}
              selfUid={uid}
              error={voiceError}
              disabled={isBanned || !isAuthReady || !uid}
              onJoin={() => { void joinVoice(); }}
              onLeave={leaveVoice}
              onToggleMute={toggleVoiceMute}
            />
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700 rounded-lg transition-colors"
              title="Toggle theme"
            >
              {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isAuthReady ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                <span className="text-sm font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                    {isAuthReady ? 'Connected' : 'Connecting'}
                </span>
            </div>
        </div>
      </header>

      {isBanned ? (
        <main className="max-w-lg mx-auto p-8">
          <div className="bg-white dark:bg-stone-950 border border-rose-200 dark:border-rose-900 rounded-2xl p-8 text-center">
            <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">You've been banned</h2>
            <p className="text-sm text-stone-500 dark:text-stone-400 mt-2">An admin removed you from this room.</p>
            <a href="/" className="inline-block mt-6 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-5 py-2.5 rounded-xl">
              Back home
            </a>
          </div>
        </main>
      ) : (
      <main className="max-w-7xl mx-auto p-6 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">

        <div className="lg:col-span-2 space-y-8 order-1">
            <div className="bg-white dark:bg-stone-950 rounded-2xl shadow-sm border border-stone-200 dark:border-stone-800 p-6 transition-colors duration-200">
            {isAdmin ? (
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4">
                <form onSubmit={handleUrlSubmit} className="flex flex-1 items-center gap-3">
                    <div className="relative flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400 dark:text-stone-500">
                            <Link className="h-5 w-5" />
                        </div>
                        <input
                            type="url"
                            value={inputUrl}
                            onChange={(e) => setInputUrl(e.target.value)}
                            placeholder="Paste YouTube, Vimeo, or Video URL here..."
                            className="block w-full pl-10 pr-4 py-3 bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow text-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={!isAuthReady}
                        className="bg-stone-900 hover:bg-stone-800 dark:bg-indigo-600 dark:hover:bg-indigo-500 text-white font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap h-full disabled:opacity-50"
                    >
                        Load Video
                    </button>
                </form>

                <div className="hidden md:block w-px h-10 bg-stone-200 dark:bg-stone-800 transition-colors"></div>
                <div className="md:hidden h-px w-full bg-stone-200 dark:bg-stone-800 my-2 transition-colors"></div>

                <div className="flex flex-col items-center gap-2">
                    <div className="flex items-center gap-2 w-full">
                        <input
                            type="file"
                            accept="video/*"
                            className="hidden"
                            ref={fileInputRef}
                            onChange={handleFileUpload}
                        />
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploading || !isAuthReady}
                            className="flex flex-1 md:flex-none items-center justify-center gap-2 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed h-full"
                        >
                            <Upload className="w-5 h-5" />
                            {isUploading ? `Uploading ${uploadProgress}%` : 'Upload Video'}
                        </button>
                        <input
                            type="file"
                            accept="video/*"
                            className="hidden"
                            ref={streamInputRef}
                            onChange={handleLocalStreamFile}
                        />
                        <button
                            type="button"
                            onClick={() => streamInputRef.current?.click()}
                            disabled={!isAuthReady}
                            title="Play a file from this computer. Others watch live — nothing is uploaded."
                            className="flex flex-1 md:flex-none items-center justify-center gap-2 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap disabled:opacity-50 h-full"
                        >
                            <Cast className="w-5 h-5" />
                            Stream file
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowVideoList(true)}
                            title="Video Library"
                            disabled={!isAuthReady}
                            className="flex items-center justify-center bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-700 dark:text-stone-300 border border-stone-300 dark:border-stone-700 p-3 rounded-xl transition-colors shadow-sm h-full disabled:opacity-50"
                        >
                            <List className="w-5 h-5" />
                        </button>
                        <button
                            type="button"
                            onClick={handleClearVideo}
                            title="Clear and Delete Current Video"
                            disabled={!url}
                            className="flex items-center justify-center bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/50 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 p-3 rounded-xl transition-colors shadow-sm h-full disabled:opacity-50"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    </div>
                    {isUploading && (
                        <div className="w-full bg-stone-200 dark:bg-stone-800 rounded-full h-1.5 overflow-hidden transition-colors">
                            <div className="bg-indigo-600 dark:bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
                        </div>
                    )}
                </div>
            </div>
            ) : (
              <div className="flex items-center gap-3 text-stone-600 dark:text-stone-400">
                <Shield className="w-5 h-5 text-indigo-500 shrink-0" />
                <p className="text-sm">
                  {url === LOCAL_STREAM_URL
                    ? `Admin is streaming${castTitle ? `: ${castTitle}` : ' a local file'}.`
                    : 'Only the room admin can paste a link, upload, or stream a local file. You can watch and chat.'}
                </p>
              </div>
            )}
        </div>

        <div className="bg-black rounded-2xl overflow-hidden shadow-xl aspect-video relative group">
          {url === LOCAL_STREAM_URL && !isCastHost ? (
            <>
              <video
                ref={(el) => {
                  remoteCastRef.current = el;
                  if (el && remoteCastStream && el.srcObject !== remoteCastStream) {
                    el.srcObject = remoteCastStream;
                    void el.play().catch(() => setNeedsUnlock(true));
                  }
                }}
                className="absolute inset-0 w-full h-full object-contain bg-black"
                autoPlay
                playsInline
                controls
              />
              {!remoteCastStream ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-stone-400">
                  <Cast className="w-10 h-10 text-stone-600" />
                  <p className="text-sm">{castError || 'Connecting to host stream…'}</p>
                </div>
              ) : null}
            </>
          ) : url ? (
            <ReactPlayer
              ref={playerRef}
              src={url}
              width="100%"
              height="100%"
              playing={playing}
              controls={true}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              onReady={() => {
                applyPendingSync();
                setPlayerReadyTick((tick) => tick + 1);
                startHostCastFromPlayer();
              }}
              onPlay={() => {
                handlePlay();
                startHostCastFromPlayer();
              }}
              onPause={handlePause}
              onTimeUpdate={handleTimeUpdate}
              onSeeked={handleSeeked}
            >
              {playableCaptions.map((track) => (
                captionSrcById[track.id] ? (
                <track
                  key={track.id}
                  kind="subtitles"
                  src={captionSrcById[track.id]}
                  srcLang={track.lang}
                  label={track.label}
                  data-track-id={track.id}
                />
                ) : null
              ))}
            </ReactPlayer>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-stone-400">
              <Video className="w-12 h-12 text-stone-600" />
              <p className="text-sm">
                {isAdmin ? 'Paste a URL, upload, or stream a file from this computer.' : 'Waiting for the admin to add a video.'}
              </p>
            </div>
          )}
          {(isCastHost || url === LOCAL_STREAM_URL) && (
            <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg bg-black/60 px-2.5 py-1 text-xs text-white">
              <Cast className="w-3.5 h-3.5" />
              <span className="max-w-[14rem] truncate">{castTitle || 'Local stream'}</span>
            </div>
          )}
          {castError ? (
            <div className="absolute right-3 top-3 z-10 rounded-lg bg-rose-600/90 px-2.5 py-1 text-xs text-white max-w-[16rem] truncate">
              {castError}
            </div>
          ) : null}
          {needsUnlock && url && (
            <button
              type="button"
              onClick={() => {
                setNeedsUnlock(false);
                setPlaying(true);
                if (url === LOCAL_STREAM_URL) {
                  void remoteCastRef.current?.play();
                } else {
                  void getMedia(playerRef.current)?.play?.();
                }
              }}
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 text-white"
            >
              <Play className="w-12 h-12" />
              <span className="text-sm font-medium">Click to sync playback</span>
            </button>
          )}
        </div>
        {url && isUploadedVideo(url) ? (
          <MediaTrackBar
            url={url}
            isAdmin={isAdmin}
            captions={playableCaptions}
            extraAudio={extraAudioTracks}
            selectedCaptionId={selectedCaptionId}
            selectedAudioId={selectedAudioId}
            onCaptionChange={setSelectedCaptionId}
            onAudioChange={setSelectedAudioId}
            onUploadCaption={(file) => { void handleCaptionUpload(file); }}
            onUploadAudio={(file) => { void handleAudioTrackUpload(file); }}
            playerRef={playerRef}
            playing={playing}
            readyTick={playerReadyTick}
          />
        ) : null}

        <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50 rounded-xl p-5 flex items-start gap-4 justify-between transition-colors">
            <div className="flex items-start gap-4">
                <Users className="w-6 h-6 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                <div>
                    <h3 className="font-semibold text-indigo-900 dark:text-indigo-300">Room: {roomId}</h3>
                    <p className="text-indigo-700 dark:text-indigo-400/80 text-sm mt-1 max-w-xl">
                        {url === LOCAL_STREAM_URL || isCastHost
                          ? `Streaming from a computer${castTitle ? `: ${castTitle}` : ''}. Host controls playback.`
                          : isAdmin
                            ? 'You are the admin. Open People to grant admin or ban someone.'
                            : 'Share this page with a friend. Play, pause, and seek stay in sync.'}
                        {' '}{userCount} online
                        {viewerNames.length > 0 ? `: ${viewerNames.join(', ')}` : '.'}
                    </p>
                </div>
            </div>

            <button
                onClick={() => {
                    navigator.clipboard.writeText(window.location.href);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                }}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
            >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied!' : 'Copy Invite Link'}
            </button>
        </div>
        </div>

        <div className="lg:col-span-1 order-2 lg:sticky lg:top-24 self-start">
          <Chat roomId={roomId} socket={socket} displayName={displayName} disabled={isBanned} />
        </div>

      </main>
      )}

      {showPeople && !isBanned ? (
        <RoomMembers
          members={members}
          banned={bannedUsers}
          isAdmin={isAdmin}
          currentUid={uid}
          onClose={() => setShowPeople(false)}
          onGrantAdmin={grantAdmin}
          onRevokeAdmin={revokeAdmin}
          onBan={banMember}
          onUnban={unbanUser}
        />
      ) : null}

      {showVideoList && (
        <div className="fixed inset-0 bg-stone-900/50 dark:bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-stone-900 rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh] border border-transparent dark:border-stone-800 transition-colors duration-200">
            <div className="px-6 py-4 border-b border-stone-100 dark:border-stone-800 flex items-center justify-between bg-stone-50 dark:bg-stone-900 transition-colors">
              <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-100 flex items-center gap-2">
                <List className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                Uploaded Videos
              </h2>
              <button
                onClick={() => setShowVideoList(false)}
                className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 bg-white dark:bg-stone-900 transition-colors">
              {uploadedVideos.length === 0 ? (
                <div className="text-center py-10 text-stone-500 dark:text-stone-400">
                  <Video className="w-12 h-12 text-stone-200 dark:text-stone-700 mx-auto mb-3" />
                  <p>No videos uploaded to this room yet.</p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {uploadedVideos.map((video, idx) => (
                    <li key={idx} className="flex items-center justify-between p-3 rounded-xl border border-stone-100 dark:border-stone-800 hover:border-indigo-200 dark:hover:border-indigo-500/30 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/20 transition-colors group">
                      <div className="flex items-center gap-3 truncate">
                        <div className="bg-indigo-100 dark:bg-indigo-900/50 p-2 rounded-lg text-indigo-600 dark:text-indigo-400">
                          <Play className="w-4 h-4" />
                        </div>
                        <span className="font-medium text-stone-700 dark:text-stone-300 truncate" title={video.name}>
                          {video.name.replace(/^\d+_/, '')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => {
                            if (!isAdmin) return;
                            updateRoomState(video.url);
                            setShowVideoList(false);
                          }}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                          Play
                        </button>
                        <button
                          onClick={async () => {
                            if (!window.confirm('Delete this video from the room library?')) return;
                            try {
                              await deleteObject(ref(storage, video.path));
                              fetchUploadedVideos();
                              if (url === video.url) {
                                await updateRoomState('');
                              }
                            } catch (e) {
                              console.error('Failed to delete', e);
                            }
                          }}
                          className="p-1.5 text-rose-500 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-950/50 rounded-lg transition-colors"
                          title="Delete video"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
