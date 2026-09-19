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

export function hasAnyAdmin(adminUids: unknown): boolean {
  if (!adminUids || typeof adminUids !== 'object') return false;
  return Object.values(adminUids as Record<string, unknown>).some((value) => value === true);
}

export function isUidAdmin(adminUids: unknown, uid: string): boolean {
  if (!uid || !adminUids || typeof adminUids !== 'object') return false;
  return (adminUids as Record<string, unknown>)[uid] === true;
}
