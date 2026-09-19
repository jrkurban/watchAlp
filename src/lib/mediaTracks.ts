export type CaptionTrack = {
  id: string;
  label: string;
  lang: string;
  vtt: string;
  url?: string;
  path?: string;
};

export type ExtraAudioTrack = {
  id: string;
  label: string;
  url: string;
  path: string;
};

export function isUploadedVideo(url: string): boolean {
  if (!url) return false;
  return !/youtube\.com|youtu\.be|vimeo\.com|wistia\.com/i.test(url);
}

export function mediaKeyFromUrl(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const marker = '/o/';
    const idx = path.indexOf(marker);
    const storagePath = idx >= 0 ? path.slice(idx + marker.length) : path;
    const file = storagePath.split('/').pop() || 'media';
    const key = file.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    return key || 'media';
  } catch {
    return 'media';
  }
}

export function labelFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return (base || 'Track').slice(0, 40);
}

export function langFromFilename(name: string): string {
  const match = name.toLowerCase().match(/(?:^|[._-])([a-z]{2})(?:[._-]|$)/);
  return match?.[1] || 'und';
}

export function toWebVtt(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (trimmed.startsWith('WEBVTT')) return `${trimmed}\n`;
  const converted = trimmed.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${converted}\n`;
}

export function getHtmlVideo(node: HTMLElement | null): HTMLVideoElement | null {
  if (!node) return null;
  if (node instanceof HTMLVideoElement) return node;
  return node.querySelector('video');
}

export function parseTrackMap<T extends { id: string }>(value: unknown): T[] {
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, T>)
    .filter((row) => {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') return false;
      const record = row as T & { url?: string; vtt?: string };
      return typeof record.url === 'string' || typeof record.vtt === 'string';
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
