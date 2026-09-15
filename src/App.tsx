import React, { useState, useEffect, useRef } from 'react';
import ReactPlayer from 'react-player';
import { io, Socket } from 'socket.io-client';
import { Play, Pause, Link, Users, Video, Copy, Check, Upload, Trash2 } from 'lucide-react';
import { initAuth, db, storage } from './lib/firebase';
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';

// Establish socket connection (assumes same host)

// It connects to the same origin by default
let socket: Socket;

const DEFAULT_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

export default function App() {
  // Determine Room ID from URL or generate a new one
  const params = new URLSearchParams(window.location.search);
  let currentRoom = params.get('room');
  if (!currentRoom) {
    currentRoom = Math.random().toString(36).substring(2, 9);
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + `?room=${currentRoom}`;
    window.history.replaceState({ path: newUrl }, '', newUrl);
  }
  const ROOM_ID = currentRoom;

  const [url, setUrl] = useState(DEFAULT_VIDEO);
  const [inputUrl, setInputUrl] = useState('');
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  
  const playerRef = useRef<ReactPlayer>(null);
  const ignoreNextPlayPause = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPlayedSeconds = useRef(0);

  useEffect(() => {
    // Initialize Firebase Auth
    initAuth().then(() => {
      // Listen to room document for persisted video url
      const roomRef = doc(db, 'rooms', ROOM_ID);
      const unsubscribe = onSnapshot(roomRef, (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.currentVideoUrl) {
            setUrl(prevUrl => prevUrl !== data.currentVideoUrl ? data.currentVideoUrl : prevUrl);
          }
        }
      });
      return () => unsubscribe();
    });

    // Connect to Socket.io server
    socket = io();

    socket.on('connect', () => {
      console.log('Connected to server');
      setIsConnected(true);
      socket.emit('joinRoom', ROOM_ID);
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setIsConnected(false);
    });

    // Listen for remote events
    socket.on('video-play', (time: number) => {
      console.log('Received play at', time);
      ignoreNextPlayPause.current = true;
      setPlaying(true);
      if (playerRef.current && Math.abs(playerRef.current.getCurrentTime() - time) > 1) {
        playerRef.current.seekTo(time, 'seconds');
        lastPlayedSeconds.current = time;
      }
    });

    socket.on('video-pause', (time: number) => {
      console.log('Received pause at', time);
      ignoreNextPlayPause.current = true;
      setPlaying(false);
      if (playerRef.current && Math.abs(playerRef.current.getCurrentTime() - time) > 1) {
        playerRef.current.seekTo(time, 'seconds');
        lastPlayedSeconds.current = time;
      }
    });

    socket.on('seek', (time: number) => {
      console.log('Received seek to', time);
      if (playerRef.current) {
        playerRef.current.seekTo(time, 'seconds');
        lastPlayedSeconds.current = time;
      }
    });

    socket.on('videoStateUpdate', (state: any) => {
       if(state.url) {
           setUrl(state.url);
       }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handlePlay = () => {
    if (ignoreNextPlayPause.current) {
      ignoreNextPlayPause.current = false;
      return;
    }
    setPlaying(true);
    if (playerRef.current) {
      socket.emit('video-play', { roomId: ROOM_ID, time: playerRef.current.getCurrentTime() });
    }
  };

  const handlePause = () => {
    if (ignoreNextPlayPause.current) {
      ignoreNextPlayPause.current = false;
      return;
    }
    setPlaying(false);
    if (playerRef.current) {
      socket.emit('video-pause', { roomId: ROOM_ID, time: playerRef.current.getCurrentTime() });
    }
  };

  const handleProgress = (state: { played: number; playedSeconds: number }) => {
    setPlayed(state.played);
    
    // Detect seeking (if progress jumps more than 1.5 seconds unexpectedly)
    if (Math.abs(state.playedSeconds - lastPlayedSeconds.current) > 1.5 && playing) {
       socket.emit('seek', { roomId: ROOM_ID, time: state.playedSeconds });
    }
    lastPlayedSeconds.current = state.playedSeconds;
  };

  const updateRoomState = async (newUrl: string) => {
      setUrl(newUrl);
      socket.emit('videoStateUpdate', { roomId: ROOM_ID, state: { url: newUrl } });
      try {
        const roomRef = doc(db, 'rooms', ROOM_ID);
        await setDoc(roomRef, { currentVideoUrl: newUrl, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (err) {
        console.error("Failed to update room state in Firestore", err);
      }
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if(inputUrl.trim()) {
          updateRoomState(inputUrl);
          setInputUrl('');
      }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);

    const storageRef = ref(storage, `rooms/${ROOM_ID}/${Date.now()}_${file.name}`);
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
          console.error("Error setting video URL", error);
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
    if (url.includes('firebasestorage')) {
      try {
        const storageRef = ref(storage, url);
        await deleteObject(storageRef);
      } catch (err) {
        console.error("Failed to delete from storage", err);
      }
    }
    await updateRoomState('https://www.youtube.com/watch?v=dQw4w9WgXcQ'); // Reset to default or empty
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans selection:bg-stone-200">
      <header className="bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-sm">
                <Video className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-stone-800">SyncWatch</h1>
        </div>
        
        <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
            <span className="text-sm font-medium text-stone-500 uppercase tracking-wider">
                {isConnected ? 'Connected' : 'Disconnected'}
            </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 md:p-8 space-y-8">
        
        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6">
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4">
                <form onSubmit={handleUrlSubmit} className="flex flex-1 items-center gap-3">
                    <div className="relative flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400">
                            <Link className="h-5 w-5" />
                        </div>
                        <input 
                            type="url" 
                            value={inputUrl}
                            onChange={(e) => setInputUrl(e.target.value)}
                            placeholder="Paste YouTube, Vimeo, or Video URL here..."
                            className="block w-full pl-10 pr-4 py-3 bg-stone-50 border border-stone-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow text-stone-800"
                        />
                    </div>
                    <button 
                        type="submit"
                        className="bg-stone-900 hover:bg-stone-800 text-white font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap h-full"
                    >
                        Load Video
                    </button>
                </form>
                
                <div className="hidden md:block w-px h-10 bg-stone-200"></div>
                <div className="md:hidden h-px w-full bg-stone-200 my-2"></div>
                
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
                            disabled={isUploading}
                            className="flex flex-1 md:flex-none items-center justify-center gap-2 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed h-full"
                        >
                            <Upload className="w-5 h-5" />
                            {isUploading ? `Uploading ${uploadProgress}%` : 'Upload Video'}
                        </button>
                        <button
                            type="button"
                            onClick={handleClearVideo}
                            title="Clear and Delete Video"
                            className="flex items-center justify-center bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 p-3 rounded-xl transition-colors shadow-sm h-full"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    </div>
                    {isUploading && (
                        <div className="w-full bg-stone-200 rounded-full h-1.5 overflow-hidden">
                            <div className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
                        </div>
                    )}
                </div>
            </div>
        </div>

        <div className="bg-black rounded-2xl overflow-hidden shadow-xl aspect-video relative group">
          <ReactPlayer
            ref={playerRef}
            url={url}
            width="100%"
            height="100%"
            playing={playing}
            controls={true} // We rely on native controls for seeking, but sync them
            onPlay={handlePlay}
            onPause={handlePause}
            onProgress={handleProgress}
            config={{
              file: {
                forceVideo: url.includes('firebasestorage')
              }
            }}
          />
        </div>
        
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5 flex items-start gap-4 justify-between">
            <div className="flex items-start gap-4">
                <Users className="w-6 h-6 text-indigo-600 shrink-0 mt-0.5" />
                <div>
                    <h3 className="font-semibold text-indigo-900">Room: {ROOM_ID}</h3>
                    <p className="text-indigo-700 text-sm mt-1 max-w-xl">
                        Share this page with a friend. When you play, pause, or seek, their player will synchronize automatically.
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

      </main>
    </div>
  );
}
