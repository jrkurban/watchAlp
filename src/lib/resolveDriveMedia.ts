const FILE_ID_RE = /^[\w-]{10,128}$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type DriveMediaResult = {
  url: string;
  kind: 'media' | 'preview';
  error?: 'not-public' | 'not-video';
};

export function drivePreviewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

function isMediaType(ctype: string): boolean {
  const value = ctype.toLowerCase();
  return value.startsWith('video/')
    || value.startsWith('audio/')
    || value.includes('octet-stream')
    || value.includes('mp4');
}

function pick(html: string, ...patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function buildDownloadUrl(fileId: string, confirm?: string, uuid?: string, at?: string): string {
  const params = new URLSearchParams({
    id: fileId,
    export: 'download',
    confirm: confirm || 't',
  });
  if (uuid) params.set('uuid', uuid);
  if (at) params.set('at', at);
  return `https://drive.usercontent.google.com/download?${params.toString()}`;
}

function cookieHeader(res: Response): string {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  if (cookies.length) {
    return cookies.map((row) => row.split(';')[0]).filter(Boolean).join('; ');
  }
  const single = res.headers.get('set-cookie');
  return single ? single.split(';')[0] : '';
}

async function probe(url: string, cookie = ''): Promise<{ res: Response; ctype: string }> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*',
    Range: 'bytes=0-2047',
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  const ctype = res.headers.get('content-type') || '';
  return { res, ctype };
}

async function dropBody(res: Response) {
  try {
    await res.body?.cancel();
  } catch {
    // Ignore cancel failures; the probe payload is tiny when Range works.
  }
}

export async function openDriveFile(fileId: string, range?: string): Promise<Response> {
  if (!FILE_ID_RE.test(fileId)) {
    throw new Error('Invalid Drive file id');
  }

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*',
  };
  if (range) headers.Range = range;

  const request = (url: string, cookie = '') => {
    const next = { ...headers };
    if (cookie) next.Cookie = cookie;
    return fetch(url, { headers: next, redirect: 'follow' });
  };

  let res = await request(buildDownloadUrl(fileId, 't'));
  if (isMediaType(res.headers.get('content-type') || '')) return res;

  const html = await res.text();
  const confirm = pick(html, /name=["']confirm["']\s+value=["']([^"']+)["']/i, /[?&]confirm=([0-9A-Za-z_-]+)/);
  const uuid = pick(html, /name=["']uuid["']\s+value=["']([^"']+)["']/i, /[?&]uuid=([0-9a-f-]+)/i);
  const at = pick(html, /name=["']at["']\s+value=["']([^"']+)["']/i);
  if (!confirm && !uuid) {
    throw new Error('Drive did not return a video stream.');
  }
  res = await request(buildDownloadUrl(fileId, confirm || 't', uuid, at), cookieHeader(res));
  if (!isMediaType(res.headers.get('content-type') || '')) {
    throw new Error('Drive did not return a video stream.');
  }
  return res;
}

export async function resolveDriveMediaUrl(fileId: string): Promise<DriveMediaResult> {
  if (!FILE_ID_RE.test(fileId)) {
    throw new Error('Invalid Drive file id');
  }

  const preview = drivePreviewUrl(fileId);
  const firstUrl = buildDownloadUrl(fileId, 't');
  const first = await probe(firstUrl);

  if (isMediaType(first.ctype)) {
    await dropBody(first.res);
    return { url: firstUrl, kind: 'media' };
  }

  const html = await first.res.text();
  if (/accounts\.google\.com|you need access|need permission|request access|sign in to continue/i.test(html)) {
    return { url: preview, kind: 'preview', error: 'not-public' };
  }

  const confirm = pick(html, /name=["']confirm["']\s+value=["']([^"']+)["']/i, /[?&]confirm=([0-9A-Za-z_-]+)/);
  const uuid = pick(html, /name=["']uuid["']\s+value=["']([^"']+)["']/i, /[?&]uuid=([0-9a-f-]+)/i);
  const at = pick(html, /name=["']at["']\s+value=["']([^"']+)["']/i);
  const cookie = cookieHeader(first.res);

  if (confirm || uuid) {
    const nextUrl = buildDownloadUrl(fileId, confirm || 't', uuid, at);
    const second = await probe(nextUrl, cookie);
    if (isMediaType(second.ctype)) {
      await dropBody(second.res);
      return { url: nextUrl, kind: 'media' };
    }
    await dropBody(second.res);
  }

  return { url: preview, kind: 'preview' };
}
