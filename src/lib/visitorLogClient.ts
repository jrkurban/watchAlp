import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db, initAuth } from './firebase';

export const LOGS_KEY = 'syncwatch-logs';
export const ONLINE_MS = 20_000;
const LOG_ROOM_ID = '__visitor_logs';

export type VisitorLogRow = {
  id: string;
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  roomId: string | null;
  userAgent: string;
  enteredAt: number;
  lastSeen: number;
  exitedAt: number | null;
  online: boolean;
};

type StoredVisitor = Omit<VisitorLogRow, 'online'>;

type Geo = {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
};

const RECORD_KEY = 'visitorLogRecord';

function logDoc() {
  return doc(db, 'rooms', LOG_ROOM_ID);
}

async function lookupGeo(): Promise<Geo> {
  try {
    const response = await fetch('https://ipapi.co/json/');
    if (!response.ok) throw new Error('geo failed');
    const data = await response.json() as {
      ip?: string;
      city?: string;
      region?: string;
      country_name?: string;
      latitude?: number;
      longitude?: number;
      error?: boolean;
    };
    if (data.error) throw new Error('geo failed');
    return {
      ip: data.ip || 'unknown',
      city: data.city ?? null,
      region: data.region ?? null,
      country: data.country_name ?? null,
      lat: typeof data.latitude === 'number' ? data.latitude : null,
      lon: typeof data.longitude === 'number' ? data.longitude : null,
    };
  } catch {
    return {
      ip: 'unknown',
      city: null,
      region: null,
      country: null,
      lat: null,
      lon: null,
    };
  }
}

async function saveEntry(record: StoredVisitor) {
  const payload = {
    [`visitorEntries.${record.id}`]: record,
    currentVideoUrl: 'visitor-log',
    updatedAt: new Date().toISOString(),
  };
  try {
    await updateDoc(logDoc(), payload);
  } catch {
    await setDoc(logDoc(), {
      currentVideoUrl: 'visitor-log',
      updatedAt: new Date().toISOString(),
      visitorEntries: { [record.id]: record },
    }, { merge: true });
  }
  sessionStorage.setItem(RECORD_KEY, JSON.stringify(record));
}

export async function upsertVisitorLog(input: {
  sessionId?: string | null;
  roomId: string;
}): Promise<string> {
  await initAuth();
  const now = Date.now();
  const existingId = input.sessionId?.trim();
  let cached: StoredVisitor | null = null;
  try {
    cached = JSON.parse(sessionStorage.getItem(RECORD_KEY) || 'null') as StoredVisitor | null;
  } catch {
    cached = null;
  }

  if (existingId && cached?.id === existingId) {
    const next = { ...cached, roomId: input.roomId, lastSeen: now, exitedAt: null };
    await saveEntry(next);
    return existingId;
  }

  const geo = await lookupGeo();
  const record: StoredVisitor = {
    id: existingId || crypto.randomUUID(),
    ip: geo.ip,
    city: geo.city,
    region: geo.region,
    country: geo.country,
    lat: geo.lat,
    lon: geo.lon,
    roomId: input.roomId,
    userAgent: navigator.userAgent,
    enteredAt: now,
    lastSeen: now,
    exitedAt: null,
  };
  await saveEntry(record);
  return record.id;
}

export async function heartbeatVisitorLog(id: string, roomId: string) {
  let cached: StoredVisitor | null = null;
  try {
    cached = JSON.parse(sessionStorage.getItem(RECORD_KEY) || 'null') as StoredVisitor | null;
  } catch {
    cached = null;
  }
  if (!cached || cached.id !== id) {
    await upsertVisitorLog({ sessionId: id, roomId });
    return;
  }
  await saveEntry({ ...cached, roomId, lastSeen: Date.now(), exitedAt: null });
}

export async function listVisitorLogs(): Promise<VisitorLogRow[]> {
  await initAuth();
  const snap = await getDoc(logDoc());
  const now = Date.now();
  const entries = snap.exists() ? snap.data().visitorEntries : undefined;
  if (!entries || typeof entries !== 'object') return [];
  return Object.values(entries as Record<string, StoredVisitor>)
    .map((row) => {
      const lastSeen = typeof row.lastSeen === 'number' ? row.lastSeen : 0;
      const exitedAt = typeof row.exitedAt === 'number' ? row.exitedAt : null;
      return {
        ...row,
        ip: String(row.ip ?? 'unknown'),
        roomId: row.roomId ?? null,
        userAgent: String(row.userAgent ?? ''),
        enteredAt: typeof row.enteredAt === 'number' ? row.enteredAt : 0,
        lastSeen,
        exitedAt,
        online: exitedAt == null && now - lastSeen < ONLINE_MS,
      };
    })
    .sort((a, b) => b.enteredAt - a.enteredAt)
    .slice(0, 500);
}
