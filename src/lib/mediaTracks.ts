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

const MEDIA_SELECTOR = 'hls-video, youtube-video, vimeo-video, wistia-video, video';

export function getHtmlVideo(node: HTMLElement | null): HTMLVideoElement | null {
  const seen = new Set<Element>();
  const candidates: HTMLVideoElement[] = [];
  const consider = (el: Element | null | undefined) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    if ('textTracks' in el) candidates.push(el as HTMLVideoElement);
    el.querySelectorAll?.(MEDIA_SELECTOR).forEach((child) => consider(child));
  };
  consider(node);
  consider(node?.parentElement ?? undefined);
  consider(document.querySelector('.aspect-video'));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (b.textTracks?.length ?? 0) - (a.textTracks?.length ?? 0))[0];
}

function isCaptionKind(kind: string) {
  return kind === 'subtitles' || kind === 'captions';
}

export type EmbeddedCaption = {
  id: string;
  label: string;
  language: string;
};

export function collectEmbeddedCaptions(video: HTMLVideoElement | null): EmbeddedCaption[] {
  if (!video?.textTracks) return [];
  const injected = new Set<TextTrack>();
  video.querySelectorAll?.('track').forEach((el) => {
    if (el.track) injected.add(el.track);
  });
  const next: EmbeddedCaption[] = [];
  for (let i = 0; i < video.textTracks.length; i += 1) {
    const track = video.textTracks[i];
    if (!isCaptionKind(track.kind) || injected.has(track)) continue;
    const language = track.language || '';
    const label = track.label || language || `Subtitles ${next.length + 1}`;
    next.push({
      id: `inband:${language}:${label}:${i}`,
      label,
      language,
    });
  }
  return next;
}

function sidecarCandidates(videoUrl: string): { url: string; label: string; lang: string }[] {
  try {
    const parsed = new URL(videoUrl);
    const path = parsed.pathname;
    const dot = path.lastIndexOf('.');
    if (dot < 0) return [];
    const stem = path.slice(0, dot);
    const variants = [
      { suffix: '.vtt', label: 'Subtitles', lang: 'und' },
      { suffix: '.srt', label: 'Subtitles', lang: 'und' },
      { suffix: '.en.vtt', label: 'English', lang: 'en' },
      { suffix: '.tr.vtt', label: 'Turkish', lang: 'tr' },
      { suffix: '.en.srt', label: 'English', lang: 'en' },
      { suffix: '.tr.srt', label: 'Turkish', lang: 'tr' },
    ];
    return variants.map((variant) => {
      parsed.pathname = `${stem}${variant.suffix}`;
      return { url: parsed.toString(), label: variant.label, lang: variant.lang };
    });
  } catch {
    return [];
  }
}

export async function probeSidecarCaptions(videoUrl: string): Promise<CaptionTrack[]> {
  const found: CaptionTrack[] = [];
  await Promise.all(sidecarCandidates(videoUrl).map(async (candidate) => {
    try {
      const response = await fetch(candidate.url);
      if (!response.ok) return;
      const text = await response.text();
      if (!text.includes('WEBVTT') && !/\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) return;
      found.push({
        id: `sidecar:${candidate.lang}:${candidate.label}`,
        label: candidate.label,
        lang: candidate.lang,
        vtt: toWebVtt(text),
      });
    } catch {
      // Missing files and CORS blocks are expected.
    }
  }));
  return found.sort((a, b) => a.label.localeCompare(b.label));
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
