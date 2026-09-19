import React, { useEffect, useMemo, useState } from 'react';
import { MapPin, RefreshCw, Users } from 'lucide-react';
import { LOGS_KEY, listVisitorLogs, type VisitorLogRow } from './lib/visitorLogClient';
import { startVisitorSession } from './lib/visitorSession';

type LogRow = VisitorLogRow;

function formatTime(value: number | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function locationLabel(row: LogRow) {
  const parts = [row.city, row.region, row.country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Bilinmiyor';
}

export default function Logs() {
  const params = new URLSearchParams(window.location.search);
  const [key, setKey] = useState(params.get('key') ?? '');
  const [inputKey, setInputKey] = useState(params.get('key') ?? '');
  const [rows, setRows] = useState<LogRow[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'online'>('all');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    return startVisitorSession('logs');
  }, []);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    const load = async () => {
      if (key !== LOGS_KEY) {
        setError('Anahtar hatalı.');
        setRows([]);
        return;
      }
      try {
        const response = await fetch(`/api/logs?key=${encodeURIComponent(key)}`);
        const isJson = response.headers.get('content-type')?.includes('application/json');
        if (response.ok && isJson) {
          const data = await response.json() as { visitors: LogRow[] };
          if (cancelled) return;
          setError('');
          setRows(data.visitors ?? []);
          setUpdatedAt(Date.now());
          return;
        }
        if (response.status === 401) {
          setError('Anahtar hatalı.');
          setRows([]);
          return;
        }
      } catch {
        // Fall through to Firestore on static hosts (Vercel / Firebase).
      }
      try {
        const visitors = await listVisitorLogs();
        if (cancelled) return;
        setError('');
        setRows(visitors);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Loglar alınamadı.');
      }
    };

    load();
    const interval = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [key]);

  const visible = useMemo(
    () => (filter === 'online' ? rows.filter((row) => row.online) : rows),
    [filter, rows],
  );
  const onlineCount = rows.filter((row) => row.online).length;

  const saveKey = (event: React.FormEvent) => {
    event.preventDefault();
    const next = inputKey.trim();
    const url = new URL(window.location.href);
    url.searchParams.set('key', next);
    window.history.replaceState({}, '', url);
    setKey(next);
  };

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Apeiron</p>
            <h1 className="text-2xl font-bold mt-1">Ziyaretçi logları</h1>
            <p className="text-stone-500 dark:text-stone-400 text-sm mt-1">
              IP, konum, oda, giriş-çıkış ve anlık online durumu.
            </p>
            <p className="text-xs text-stone-400 mt-2 font-mono break-all">
              {`${window.location.origin}/?view=logs&key=${LOGS_KEY}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 px-3 py-2 rounded-xl">
              <Users className="w-4 h-4 text-indigo-600" />
              <span className="font-semibold tabular-nums">{onlineCount}</span>
              <span className="text-sm text-stone-500">online</span>
            </div>
            {updatedAt && (
              <div className="flex items-center gap-2 text-xs text-stone-400">
                <RefreshCw className="w-3.5 h-3.5" />
                {formatTime(updatedAt)}
              </div>
            )}
          </div>
        </header>

        {!key ? (
          <form onSubmit={saveKey} className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl p-6 max-w-md space-y-3">
            <label className="block text-sm font-medium">Log anahtarı</label>
            <input
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              className="w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3 py-2"
              placeholder="LOGS_KEY"
            />
            <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-sm font-medium">
              Aç
            </button>
          </form>
        ) : (
          <>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'all' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800'}`}
              >
                Tümü ({rows.length})
              </button>
              <button
                type="button"
                onClick={() => setFilter('online')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'online' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800'}`}
              >
                Online ({onlineCount})
              </button>
            </div>

            {error && (
              <p className="text-rose-600 text-sm">{error}</p>
            )}

            <div className="overflow-x-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl">
              <table className="w-full text-sm">
                <thead className="text-left text-stone-500 border-b border-stone-200 dark:border-stone-800">
                  <tr>
                    <th className="px-4 py-3 font-medium">Durum</th>
                    <th className="px-4 py-3 font-medium">IP</th>
                    <th className="px-4 py-3 font-medium">Konum</th>
                    <th className="px-4 py-3 font-medium">Oda</th>
                    <th className="px-4 py-3 font-medium">Giriş</th>
                    <th className="px-4 py-3 font-medium">Son görülme</th>
                    <th className="px-4 py-3 font-medium">Çıkış</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-stone-400">
                        Henüz kayıt yok.
                      </td>
                    </tr>
                  ) : visible.map((row) => (
                    <tr key={row.id} className="border-t border-stone-100 dark:border-stone-800">
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${row.online ? 'text-emerald-600' : 'text-stone-400'}`}>
                          <span className={`w-2 h-2 rounded-full ${row.online ? 'bg-emerald-500' : 'bg-stone-300'}`} />
                          {row.online ? 'Online' : 'Offline'}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{row.ip}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-stone-400" />
                          {locationLabel(row)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{row.roomId ?? '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatTime(row.enteredAt)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatTime(row.lastSeen)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{row.online ? '—' : formatTime(row.exitedAt ?? row.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
