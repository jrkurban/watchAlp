import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export const ONLINE_MS = 20_000;

export type VisitorRecord = {
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
};

type GeoInfo = {
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
};

const STORE_FILE = path.join(process.cwd(), 'data', 'visitor-logs.json');
const geoCache = new Map<string, GeoInfo>();

function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/, '').trim();
}

function isPrivateIp(ip: string): boolean {
  const value = normalizeIp(ip);
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === 'localhost' ||
    value.startsWith('10.') ||
    value.startsWith('192.168.') ||
    value.startsWith('172.16.') ||
    value.startsWith('172.17.') ||
    value.startsWith('172.18.') ||
    value.startsWith('172.19.') ||
    value.startsWith('172.2') ||
    value.startsWith('172.30.') ||
    value.startsWith('172.31.')
  );
}

export function getClientIp(headers: Record<string, unknown>, fallback = ''): string {
  const forwarded = headers['x-forwarded-for'];
  const headerValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return normalizeIp(headerValue.split(',')[0] ?? '');
  }
  const realIp = headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return normalizeIp(realIp);
  return normalizeIp(fallback);
}

async function lookupGeo(ip: string): Promise<GeoInfo> {
  const empty: GeoInfo = { city: null, region: null, country: null, lat: null, lon: null };
  if (!ip || isPrivateIp(ip)) {
    return { ...empty, city: 'Yerel ağ', country: 'Local' };
  }
  const cached = geoCache.get(ip);
  if (cached) return cached;
  try {
    const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,lat,lon`);
    if (!response.ok) return empty;
    const data = await response.json() as {
      status?: string;
      country?: string;
      regionName?: string;
      city?: string;
      lat?: number;
      lon?: number;
    };
    if (data.status !== 'success') return empty;
    const geo: GeoInfo = {
      city: data.city ?? null,
      region: data.regionName ?? null,
      country: data.country ?? null,
      lat: typeof data.lat === 'number' ? data.lat : null,
      lon: typeof data.lon === 'number' ? data.lon : null,
    };
    geoCache.set(ip, geo);
    return geo;
  } catch {
    return empty;
  }
}

function isOnline(record: VisitorRecord, now = Date.now()): boolean {
  return record.exitedAt == null && now - record.lastSeen < ONLINE_MS;
}

export function createVisitorStore() {
  let records: VisitorRecord[] = [];
  let loaded = false;

  const persist = async () => {
    await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
    await fs.writeFile(STORE_FILE, JSON.stringify(records, null, 2));
  };

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as VisitorRecord[];
      if (Array.isArray(parsed)) records = parsed;
    } catch {
      records = [];
    }
  };

  const touch = async (input: {
    sessionId?: string;
    ip: string;
    userAgent: string;
    roomId?: string | null;
  }) => {
    await load();
    const now = Date.now();
    const existing = input.sessionId
      ? records.find((row) => row.id === input.sessionId)
      : undefined;

    if (existing && isOnline(existing, now)) {
      existing.lastSeen = now;
      existing.exitedAt = null;
      if (input.roomId) existing.roomId = input.roomId;
      await persist();
      return existing;
    }

    const geo = await lookupGeo(input.ip);
    const record: VisitorRecord = {
      id: randomUUID(),
      ip: input.ip || 'unknown',
      ...geo,
      roomId: input.roomId ?? existing?.roomId ?? null,
      userAgent: input.userAgent || 'unknown',
      enteredAt: now,
      lastSeen: now,
      exitedAt: null,
    };
    records.unshift(record);
    records = records.slice(0, 2000);
    await persist();
    return record;
  };

  const heartbeat = async (id: string, roomId?: string | null) => {
    await load();
    const record = records.find((row) => row.id === id);
    if (!record) return null;
    record.lastSeen = Date.now();
    record.exitedAt = null;
    if (roomId) record.roomId = roomId;
    await persist();
    return record;
  };

  const leave = async (id: string) => {
    await load();
    const record = records.find((row) => row.id === id);
    if (!record) return null;
    record.lastSeen = Date.now();
    record.exitedAt = Date.now();
    await persist();
    return record;
  };

  const list = async () => {
    await load();
    const now = Date.now();
    return records.map((row) => ({
      ...row,
      online: isOnline(row, now),
    }));
  };

  return { touch, heartbeat, leave, list };
}
