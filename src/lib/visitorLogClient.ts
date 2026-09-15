import { collection, doc, getDocs, query, setDoc, updateDoc, orderBy, limit } from 'firebase/firestore';
import { db, initAuth } from './firebase';

export const LOGS_KEY = 'syncwatch-logs';
export const ONLINE_MS = 20_000;

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

type Geo = {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
};

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

export async function upsertVisitorLog(input: {
  sessionId?: string | null;
  roomId: string;
}): Promise<string> {
  await initAuth();
  const now = Date.now();
  const existingId = input.sessionId?.trim();
  if (existingId) {
    try {
      await updateDoc(doc(db, 'visitorLogs', existingId), {
        roomId: input.roomId,
        lastSeen: now,
        exitedAt: null,
      });
      return existingId;
    } catch {
      // Fall through and create a new row.
    }
  }

  const geo = await lookupGeo();
  const id = crypto.randomUUID();
  await setDoc(doc(db, 'visitorLogs', id), {
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
  });
  return id;
}

export async function heartbeatVisitorLog(id: string, roomId: string) {
  await updateDoc(doc(db, 'visitorLogs', id), {
    roomId,
    lastSeen: Date.now(),
    exitedAt: null,
  });
}

export async function leaveVisitorLog(id: string) {
  await updateDoc(doc(db, 'visitorLogs', id), {
    lastSeen: Date.now(),
    exitedAt: Date.now(),
  });
}

export async function listVisitorLogs(): Promise<VisitorLogRow[]> {
  await initAuth();
  const snap = await getDocs(query(collection(db, 'visitorLogs'), orderBy('enteredAt', 'desc'), limit(500)));
  const now = Date.now();
  return snap.docs.map((row) => {
    const data = row.data();
    const lastSeen = typeof data.lastSeen === 'number' ? data.lastSeen : 0;
    const exitedAt = typeof data.exitedAt === 'number' ? data.exitedAt : null;
    return {
      id: row.id,
      ip: String(data.ip ?? 'unknown'),
      city: data.city ?? null,
      region: data.region ?? null,
      country: data.country ?? null,
      lat: typeof data.lat === 'number' ? data.lat : null,
      lon: typeof data.lon === 'number' ? data.lon : null,
      roomId: data.roomId ?? null,
      userAgent: String(data.userAgent ?? ''),
      enteredAt: typeof data.enteredAt === 'number' ? data.enteredAt : 0,
      lastSeen,
      exitedAt,
      online: exitedAt == null && now - lastSeen < ONLINE_MS,
    };
  });
}
