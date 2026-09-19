import React, { useEffect, useRef, useState } from 'react';
import { Captions, Languages, Upload } from 'lucide-react';
import { getHtmlVideo, type CaptionTrack, type ExtraAudioTrack } from '../lib/mediaTracks';

type EmbeddedAudio = { id: string; label: string };

type Props = {
  url: string;
  isAdmin: boolean;
  captions: CaptionTrack[];
  extraAudio: ExtraAudioTrack[];
  selectedCaptionId: string;
  selectedAudioId: string;
  onCaptionChange: (id: string) => void;
  onAudioChange: (id: string) => void;
  onUploadCaption: (file: File) => void;
  onUploadAudio: (file: File) => void;
  playerRef: React.RefObject<HTMLVideoElement | null>;
  playing: boolean;
  readyTick: number;
};

function readAudioTracks(video: HTMLVideoElement | null) {
  return video
    ? (video as HTMLVideoElement & {
      audioTracks?: { length: number; [index: number]: { id?: string; label?: string; language?: string; enabled: boolean } };
    }).audioTracks
    : undefined;
}

export function MediaTrackBar({
  url,
  isAdmin,
  captions,
  extraAudio,
  selectedCaptionId,
  selectedAudioId,
  onCaptionChange,
  onAudioChange,
  onUploadCaption,
  onUploadAudio,
  playerRef,
  playing,
  readyTick,
}: Props) {
  const extraAudioRef = useRef<HTMLAudioElement | null>(null);
  const captionInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [embeddedAudio, setEmbeddedAudio] = useState<EmbeddedAudio[]>([]);

  const selectedFileAudio = extraAudio.find((track) => `file:${track.id}` === selectedAudioId);

  useEffect(() => {
    const video = getHtmlVideo(playerRef.current);
    const list = readAudioTracks(video);
    if (!list || list.length < 2) {
      setEmbeddedAudio([]);
      return;
    }
    const next: EmbeddedAudio[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const track = list[i];
      next.push({
        id: String(track.id || i),
        label: track.label || track.language || `Audio ${i + 1}`,
      });
    }
    setEmbeddedAudio(next);
  }, [url, playerRef, extraAudio.length, readyTick]);

  useEffect(() => {
    const apply = () => {
      const video = getHtmlVideo(playerRef.current);
      if (!video?.textTracks) return;
      const selectedLabel = captions.find((item) => item.id === selectedCaptionId)?.label;
      for (let i = 0; i < video.textTracks.length; i += 1) {
        const track = video.textTracks[i];
        track.mode = selectedCaptionId && track.label === selectedLabel ? 'showing' : 'disabled';
      }
    };
    apply();
    const timer = window.setTimeout(apply, 400);
    return () => window.clearTimeout(timer);
  }, [selectedCaptionId, captions, url, playerRef, readyTick]);

  useEffect(() => {
    const video = getHtmlVideo(playerRef.current);
    const list = readAudioTracks(video);
    if (list && list.length) {
      for (let i = 0; i < list.length; i += 1) {
        const track = list[i];
        const embeddedId = `embedded:${track.id || i}`;
        track.enabled = selectedAudioId === 'default' ? i === 0 : selectedAudioId === embeddedId;
      }
    }
    if (video) video.muted = Boolean(selectedFileAudio);
  }, [selectedAudioId, selectedFileAudio, url, playerRef, readyTick]);

  useEffect(() => {
    const audio = extraAudioRef.current;
    const video = getHtmlVideo(playerRef.current);
    if (!audio || !selectedFileAudio || !video) {
      extraAudioRef.current?.pause();
      return;
    }
    if (audio.src !== selectedFileAudio.url) audio.src = selectedFileAudio.url;
    const sync = () => {
      if (Math.abs(audio.currentTime - video.currentTime) > 0.35) {
        audio.currentTime = video.currentTime;
      }
    };
    sync();
    if (playing) void audio.play().catch(() => {});
    else audio.pause();
    video.addEventListener('timeupdate', sync);
    video.addEventListener('seeked', sync);
    return () => {
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('seeked', sync);
    };
  }, [playing, selectedFileAudio, url, playerRef, readyTick]);

  return (
    <div className="bg-white dark:bg-stone-950 border border-stone-200 dark:border-stone-800 rounded-xl p-3 flex flex-col sm:flex-row gap-3 sm:items-center">
      <audio ref={extraAudioRef} preload="auto" />
      <div className="flex items-center gap-2 flex-1">
        <Languages className="w-4 h-4 text-indigo-500 shrink-0" />
        <label className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wide shrink-0">Audio</label>
        <select
          value={selectedAudioId}
          onChange={(e) => onAudioChange(e.target.value)}
          className="flex-1 min-w-0 bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg px-3 py-2 text-sm"
        >
          <option value="default">Default</option>
          {embeddedAudio.map((track) => (
            <option key={track.id} value={`embedded:${track.id}`}>{track.label}</option>
          ))}
          {extraAudio.map((track) => (
            <option key={track.id} value={`file:${track.id}`}>{track.label}</option>
          ))}
        </select>
        {isAdmin ? (
          <>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadAudio(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => audioInputRef.current?.click()}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800"
              title="Upload audio track"
            >
              <Upload className="w-4 h-4" />
              Audio
            </button>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-2 flex-1">
        <Captions className="w-4 h-4 text-indigo-500 shrink-0" />
        <label className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wide shrink-0">CC</label>
        <select
          value={selectedCaptionId}
          onChange={(e) => onCaptionChange(e.target.value)}
          className="flex-1 min-w-0 bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Off</option>
          {captions.map((track) => (
            <option key={track.id} value={track.id}>{track.label}</option>
          ))}
        </select>
        {isAdmin ? (
          <>
            <input
              ref={captionInputRef}
              type="file"
              accept=".vtt,.srt,text/vtt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadCaption(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => captionInputRef.current?.click()}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800"
              title="Upload subtitles"
            >
              <Upload className="w-4 h-4" />
              Subs
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
