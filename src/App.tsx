import React, { useState, useEffect, useRef, SyntheticEvent } from 'react';
import ReactPlayer from 'react-player';
import { io, Socket } from 'socket.io-client';
import { Play, Link, Users, Video, Copy, Check, Upload, Trash2, List, X, Sun, Moon } from 'lucide-react';
import { initAuth, db, storage } from './lib/firebase';
import { deleteField, doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject, listAll } from 'firebase/storage';
import { Chat } from './components/Chat';
import { startVisitorSession } from './lib/visitorSession';

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
  const [isConnected, setIsConnected] = useState(false);
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

  const playerRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const playingRef = useRef(false);
  const urlRef = useRef('');
  const uidRef = useRef('');
  const ignoreNextPlayPause = useRef(false);
  const ignoreSeekUntil = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPlayedSeconds = useRef(0);
  const lastSyncSentAt = useRef(0);
  const pendingSync = useRef<{ time: number; playing: boolean } | null>(null);
  const applyRemotePlaybackRef = useRef<(time: number, nextPlaying?: boolean) => void>(() => {});

  playingRef.current = playing;
  urlRef.current = url;
  uidRef.current = uid;

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

  const writePlayback = async (patch: { playing?: boolean; time?: number; currentVideoUrl?: string }) => {
    if (!uidRef.current) return;
    try {
      await setDoc(doc(db, 'rooms', roomId), {
        currentVideoUrl: patch.currentVideoUrl ?? urlRef.current,
        playing: patch.playing ?? playingRef.current,
        time: patch.time ?? lastPlayedSeconds.current,
        playbackUpdatedAt: Date.now(),
        playbackUpdatedBy: uidRef.current,
        updatedAt: new Date().toISOString(),
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
        if (typeof data.currentVideoUrl === 'string') {
          setUrl((prevUrl) => (prevUrl !== data.currentVideoUrl ? data.currentVideoUrl : prevUrl));
        }

        const beats = data.viewerHeartbeats;
        if (beats && typeof beats === 'object') {
          const now = Date.now();
          const online = Object.values(beats).filter((value) => (
            typeof value === 'number' && now - value < PRESENCE_TTL_MS
          )).length;
          setUserCount(Math.max(1, online));
        }

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
      setIsConnected(true);
      nextSocket.emit('joinRoom', roomId);
    });

    nextSocket.on('disconnect', () => {
      setIsConnected(false);
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
    if (!uid || !isAuthReady) return;
    const roomRef = doc(db, 'rooms', roomId);
    const pulse = async () => {
      try {
        await updateDoc(roomRef, { [`viewerHeartbeats.${uid}`]: Date.now() });
      } catch {
        await setDoc(roomRef, {
          currentVideoUrl: urlRef.current,
          viewerHeartbeats: { [uid]: Date.now() },
        }, { merge: true });
      }
    };
    pulse();
    const interval = window.setInterval(pulse, 8000);
    return () => {
      window.clearInterval(interval);
      updateDoc(roomRef, { [`viewerHeartbeats.${uid}`]: deleteField() }).catch(() => {});
    };
  }, [uid, roomId, isAuthReady]);

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
    setUrl(newUrl);
    setPlaying(false);
    lastPlayedSeconds.current = 0;
    socketRef.current?.emit('videoStateUpdate', { roomId, state: { url: newUrl } });
    await writePlayback({ currentVideoUrl: newUrl, playing: false, time: 0 });
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl.trim()) {
      updateRoomState(inputUrl.trim());
      setInputUrl('');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
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
    if (!url) return;
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
            <h1 className="text-xl font-bold tracking-tight text-stone-800 dark:text-stone-100">SyncWatch</h1>
        </a>

        <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 px-3 py-1.5 rounded-lg">
                <Users className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span className="text-sm font-semibold tabular-nums">{userCount}</span>
                <span className="text-sm font-medium">online</span>
            </div>
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700 rounded-lg transition-colors"
              title="Toggle theme"
            >
              {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                <span className="text-sm font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider">
                    {isConnected ? 'Connected' : 'Disconnected'}
                </span>
            </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">

        <div className="lg:col-span-2 space-y-8 order-1">
            <div className="bg-white dark:bg-stone-950 rounded-2xl shadow-sm border border-stone-200 dark:border-stone-800 p-6 transition-colors duration-200">
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
        </div>

        <div className="bg-black rounded-2xl overflow-hidden shadow-xl aspect-video relative group">
          {url ? (
            <ReactPlayer
              ref={playerRef}
              src={url}
              width="100%"
              height="100%"
              playing={playing}
              controls={true}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              onReady={applyPendingSync}
              onPlay={handlePlay}
              onPause={handlePause}
              onTimeUpdate={handleTimeUpdate}
              onSeeked={handleSeeked}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-stone-400">
              <Video className="w-12 h-12 text-stone-600" />
              <p className="text-sm">Paste a URL or upload a video to start watching together.</p>
            </div>
          )}
          {needsUnlock && url && (
            <button
              type="button"
              onClick={() => {
                setNeedsUnlock(false);
                setPlaying(true);
                void getMedia(playerRef.current)?.play?.();
              }}
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 text-white"
            >
              <Play className="w-12 h-12" />
              <span className="text-sm font-medium">Click to sync playback</span>
            </button>
          )}
        </div>

        <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50 rounded-xl p-5 flex items-start gap-4 justify-between transition-colors">
            <div className="flex items-start gap-4">
                <Users className="w-6 h-6 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                <div>
                    <h3 className="font-semibold text-indigo-900 dark:text-indigo-300">Room: {roomId}</h3>
                    <p className="text-indigo-700 dark:text-indigo-400/80 text-sm mt-1 max-w-xl">
                        Share this page with a friend. Play, pause, and seek stay in sync.
                        {' '}{userCount} online.
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
          <Chat roomId={roomId} socket={socket} />
        </div>

      </main>

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
