const HOST_ROOMS_KEY = 'sw-host-rooms';

function readHostRooms(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOST_ROOMS_KEY) || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function markAsRoomHost(roomId: string) {
  const next = Array.from(new Set([...readHostRooms(), roomId]));
  localStorage.setItem(HOST_ROOMS_KEY, JSON.stringify(next));
  sessionStorage.setItem(`sw-host-${roomId}`, '1');
}

export function shouldClaimRoomAdmin(roomId: string): boolean {
  return sessionStorage.getItem(`sw-host-${roomId}`) === '1' || readHostRooms().includes(roomId);
}

export type RoomMember = {
  uid: string;
  name: string;
  online: boolean;
  isAdmin: boolean;
  isOwner: boolean;
};

export type BannedUser = {
  uid: string;
  name: string;
  at: number;
};

export function hasAnyAdmin(adminUids: unknown): boolean {
  if (!adminUids || typeof adminUids !== 'object') return false;
  return Object.values(adminUids as Record<string, unknown>).some((value) => value === true);
}

export function isUidAdmin(adminUids: unknown, uid: string): boolean {
  if (!uid || !adminUids || typeof adminUids !== 'object') return false;
  return (adminUids as Record<string, unknown>)[uid] === true;
}

export function isUidBanned(bannedUsers: unknown, uid: string): boolean {
  if (!uid || !bannedUsers || typeof bannedUsers !== 'object') return false;
  return uid in (bannedUsers as Record<string, unknown>);
}

export function parseBannedUsers(bannedUsers: unknown): BannedUser[] {
  if (!bannedUsers || typeof bannedUsers !== 'object') return [];
  return Object.entries(bannedUsers as Record<string, { name?: unknown; at?: unknown }>)
    .map(([uid, value]) => ({
      uid,
      name: typeof value?.name === 'string' && value.name.trim() ? value.name.trim() : 'Guest',
      at: typeof value?.at === 'number' ? value.at : 0,
    }))
    .sort((a, b) => b.at - a.at);
}

export function parseRoomMembers(input: {
  heartbeats: unknown;
  names: unknown;
  adminUids: unknown;
  bannedUsers: unknown;
  ownerUid: string;
  selfUid: string;
  selfName: string;
  now: number;
  onlineMs: number;
}): RoomMember[] {
  const beats = input.heartbeats && typeof input.heartbeats === 'object'
    ? input.heartbeats as Record<string, unknown>
    : {};
  const names = input.names && typeof input.names === 'object'
    ? input.names as Record<string, unknown>
    : {};
  const admins = input.adminUids && typeof input.adminUids === 'object'
    ? input.adminUids as Record<string, unknown>
    : {};
  const ids = new Set([...Object.keys(beats), ...Object.keys(names), ...Object.keys(admins)]);
  if (input.selfUid) ids.add(input.selfUid);

  return [...ids]
    .filter((uid) => !isUidBanned(input.bannedUsers, uid))
    .map((uid) => {
      const lastSeen = typeof beats[uid] === 'number' ? beats[uid] as number : 0;
      const label = names[uid];
      return {
        uid,
        name: typeof label === 'string' && label.trim()
          ? label.trim()
          : (uid === input.selfUid ? input.selfName : 'Guest'),
        online: lastSeen > 0 && input.now - lastSeen < input.onlineMs,
        isAdmin: admins[uid] === true || uid === input.ownerUid,
        isOwner: Boolean(input.ownerUid) && uid === input.ownerUid,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name));
}
