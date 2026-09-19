import React, { useEffect, useState } from 'react';
import { ArrowRight, Moon, Play, Sun, Users, Video } from 'lucide-react';
import { startVisitorSession } from './lib/visitorSession';
import { markAsRoomHost } from './lib/roomRoles';

function createRoomId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export default function Home() {
  const [roomCode, setRoomCode] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');

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
    return startVisitorSession('home');
  }, []);

  const goToRoom = (id: string) => {
    const next = new URL(window.location.href);
    next.pathname = '/';
    next.search = `?room=${encodeURIComponent(id)}`;
    window.location.assign(next.toString());
  };

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100">
      <header className="px-6 py-4 flex items-center justify-between border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white">
            <Video className="w-5 h-5" />
          </div>
          <span className="text-xl font-bold tracking-tight">Apeiron Watch</span>
        </div>
        <button
          type="button"
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="p-2 rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-300"
          title="Toggle theme"
        >
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-16 md:py-24">
        <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Watch together</p>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mt-3">
          Aynı videoyu, aynı anda izleyin.
        </h1>
        <p className="text-stone-600 dark:text-stone-400 text-lg mt-4 max-w-xl">
          Bir oda aç, linki paylaş. Play, pause ve seek herkesle senkron kalır. Sohbet de odanın içinde.
        </p>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6">
            <h2 className="font-semibold text-lg">Yeni oda</h2>
            <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
              Boş bir oda oluştur. Sen admin olursun; link ve video yükleyebilirsin.
            </p>
            <button
              type="button"
              onClick={() => {
                const id = createRoomId();
                markAsRoomHost(id);
                goToRoom(id);
              }}
              className="mt-5 inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-5 py-3 rounded-xl"
            >
              Oda oluştur
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <form
            className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6"
            onSubmit={(e) => {
              e.preventDefault();
              const id = roomCode.trim();
              if (id) goToRoom(id);
            }}
          >
            <h2 className="font-semibold text-lg">Odaya katıl</h2>
            <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
              Arkadaşının oda kodunu yaz.
            </p>
            <input
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              placeholder="Oda kodu"
              className="mt-4 w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-4 py-3"
            />
            <button
              type="submit"
              disabled={!roomCode.trim()}
              className="mt-3 inline-flex items-center gap-2 bg-stone-900 dark:bg-stone-100 dark:text-stone-900 hover:bg-stone-800 text-white font-medium px-5 py-3 rounded-xl disabled:opacity-40"
            >
              Katıl
            </button>
          </form>
        </div>

        <ul className="mt-12 grid gap-4 md:grid-cols-3 text-sm">
          <li className="flex gap-3">
            <Play className="w-5 h-5 text-indigo-600 shrink-0" />
            <span>Play / pause / seek senkron</span>
          </li>
          <li className="flex gap-3">
            <Users className="w-5 h-5 text-indigo-600 shrink-0" />
            <span>Odada kimlerin online olduğunu gör</span>
          </li>
          <li className="flex gap-3">
            <Video className="w-5 h-5 text-indigo-600 shrink-0" />
            <span>Sadece oda admini link ve video yükler</span>
          </li>
        </ul>
      </main>
    </div>
  );
}
