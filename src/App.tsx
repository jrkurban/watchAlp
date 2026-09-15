import React, { useState, useEffect, useRef } from 'react';
import ReactPlayer from 'react-player';
import { Link, Users, Video, Copy, Check, Upload } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyBm9luFeZrn01HH6MCw4ge9PHEI-o6z2n4",
  authDomain: "watch-alp.firebaseapp.com",
  projectId: "watch-alp",
  storageBucket: "watch-alp.firebasestorage.app",
  messagingSenderId: "739031307452",
  appId: "1:739031307452:web:237247129174628c566cb9",
  measurementId: "G-TQ34P8T8PS"
};

// Firebase'i Başlat
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

const DEFAULT_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

export default function App() {
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
  const [copied, setCopied] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  
  const playerRef = useRef<ReactPlayer>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isRemoteAction = useRef(false);

  useEffect(() => {
    const roomRef = doc(db, 'rooms', ROOM_ID);
    
    const unsubscribe = onSnapshot(roomRef, (docSnap) => {
      setIsConnected(true);
      if (docSnap.exists()) {
        const data = docSnap.data();
        
        if (data.url && data.url !== url) {
            setUrl(data.url);
        }

        isRemoteAction.current = true;
        setPlaying(data.playing);

        if (playerRef.current && data.time !== undefined) {
          const currentTime = playerRef.current.getCurrentTime();
          if (Math.abs(currentTime - data.time) > 1.5) {
            playerRef.current.seekTo(data.time, 'seconds');
          }
        }
        
        setTimeout(() => { isRemoteAction.current = false; }, 500);
      } else {
        setDoc(roomRef, { url: DEFAULT_VIDEO, playing: false, time: 0 });
      }
    }, (error) => {
      console.error("Firebase Connection Error:", error);
      setIsConnected(false);
    });

    return () => unsubscribe();
  }, [ROOM_ID, url]);

  const updateFirebase = async (isPlaying: boolean) => {
    if (isRemoteAction.current) return;
    const time = playerRef.current?.getCurrentTime() || 0;
    await updateDoc(doc(db, 'rooms', ROOM_ID), { playing: isPlaying, time: time });
  };

  const handlePlay = () => { setPlaying(true); updateFirebase(true); };
  const handlePause = () => { setPlaying(false); updateFirebase(false); };

  const handleUrlSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if(inputUrl.trim()) {
          await updateDoc(doc(db, 'rooms', ROOM_ID), { url: inputUrl, playing: false, time: 0 });
          setInputUrl('');
      }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const storageRef = ref(storage, `videos/${ROOM_ID}_${file.name}`);
    const uploadTask = uploadBytesResumable(storageRef, file);

    uploadTask.on('state_changed', 
      null,
      (error) => {
        console.error('Upload failed:', error);
        alert('Video yüklenirken hata oluştu.');
        setIsUploading(false);
      },
      async () => {
        const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
        await updateDoc(doc(db, 'rooms', ROOM_ID), { url: downloadURL, playing: false, time: 0 });
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    );
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans selection:bg-stone-200">
      <header className="bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-sm">
                <Video className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-stone-800">Watch-Alp</h1>
        </div>
        
        <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
            <span className="text-sm font-medium text-stone-500 uppercase tracking-wider">
                {isConnected ? 'Firebase Bağlı' : 'Bağlanıyor...'}
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
                            placeholder="Video linki yapıştır (YouTube, Mp4 vs)..."
                            className="block w-full pl-10 pr-4 py-3 bg-stone-50 border border-stone-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow text-stone-800"
                        />
                    </div>
                    <button 
                        type="submit"
                        className="bg-stone-900 hover:bg-stone-800 text-white font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap h-full"
                    >
                        Video Aç
                    </button>
                </form>
                
                <div className="hidden md:block w-px h-10 bg-stone-200"></div>
                
                <div className="flex items-center">
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
                        className="flex w-full md:w-auto items-center justify-center gap-2 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 font-medium py-3 px-6 rounded-xl transition-colors shadow-sm whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed h-full"
                    >
                        <Upload className="w-5 h-5" />
                        {isUploading ? 'Yükleniyor...' : 'Bilgisayardan Yükle'}
                    </button>
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
            controls={true}
            onPlay={handlePlay}
            onPause={handlePause}
          />
        </div>
        
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5 flex items-start gap-4 justify-between">
            <div className="flex items-start gap-4">
                <Users className="w-6 h-6 text-indigo-600 shrink-0 mt-0.5" />
                <div>
                    <h3 className="font-semibold text-indigo-900">Oda Kodu: {ROOM_ID}</h3>
                    <p className="text-indigo-700 text-sm mt-1 max-w-xl">
                        Bu sayfayı arkadaşınla paylaş. Videoyu durdurduğunda veya başlattığında onun ekranında da otomatik senkronize olacak!
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
                {copied ? 'Kopyalandı!' : 'Davet Linkini Kopyala'}
            </button>
        </div>

      </main>
    </div>
  );
}
