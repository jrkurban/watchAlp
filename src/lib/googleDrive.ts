/// <reference types="vite/client" />
import config from '../../firebase-applet-config.json';

const DRIVE_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'drive.usercontent.google.com',
]);

function driveApiKey(): string {
  const fromEnv = import.meta.env.VITE_GOOGLE_API_KEY?.trim();
  return fromEnv || config.apiKey;
}

export function parseDriveFileId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (!DRIVE_HOSTS.has(host)) return null;
    const fileMatch = url.pathname.match(/\/(?:file|uc)\/d\/([^/]+)/);
    if (fileMatch?.[1]) return fileMatch[1];
    const id = url.searchParams.get('id')?.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function isDriveUrl(raw: string): boolean {
  return Boolean(parseDriveFileId(raw));
}

export function canonicalDriveUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export function driveApiPlaybackUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(driveApiKey())}`;
}

export function driveDownloadPlaybackUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
}

export function playableVideoUrl(raw: string, useApi = false): string {
  const fileId = parseDriveFileId(raw);
  if (!fileId) return raw;
  return useApi ? driveApiPlaybackUrl(fileId) : driveDownloadPlaybackUrl(fileId);
}

type DriveErrorBody = {
  error?: {
    status?: string;
    message?: string;
    errors?: { reason?: string }[];
  };
};

export async function resolveDriveLink(raw: string): Promise<{ url: string; name: string }> {
  const trimmed = raw.trim();
  const fileId = parseDriveFileId(trimmed);
  if (!fileId) return { url: trimmed, name: '' };

  const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType&key=${encodeURIComponent(driveApiKey())}`;
  try {
    const res = await fetch(metaUrl);
    if (!res.ok) {
      const body = await res.json().catch(() => null) as DriveErrorBody | null;
      const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
      const message = body?.error?.message || '';
      const apiBlocked = reason === 'accessNotConfigured'
        || reason === 'SERVICE_DISABLED'
        || reason === 'API_KEY_SERVICE_BLOCKED'
        || reason === 'PERMISSION_DENIED'
        || /blocked|has not been used|API keys are not supported/i.test(message);
      if (apiBlocked || res.status === 403) {
        return { url: canonicalDriveUrl(fileId), name: '' };
      }
      if (res.status === 404) {
        throw new Error('Share the Drive file as Anyone with the link (Viewer), then paste the link again.');
      }
      throw new Error('Could not open this Drive file. Check the link and sharing settings.');
    }
    const meta = await res.json() as { name?: string; mimeType?: string };
    const mime = meta.mimeType || '';
    if (mime && !mime.startsWith('video/') && mime !== 'application/octet-stream') {
      throw new Error('That Drive file is not a video.');
    }
    return { url: canonicalDriveUrl(fileId), name: meta.name || '' };
  } catch (err) {
    if (err instanceof Error && (
      err.message.startsWith('Share the Drive')
      || err.message.startsWith('That Drive')
      || err.message.startsWith('Could not open')
    )) {
      throw err;
    }
    return { url: canonicalDriveUrl(fileId), name: '' };
  }
}
