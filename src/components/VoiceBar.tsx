import React from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import type { VoiceMember } from '../lib/voiceChat';
import { MAX_VOICE_PEERS } from '../lib/voiceChat';

type Props = {
  inVoice: boolean;
  muted: boolean;
  joining: boolean;
  members: VoiceMember[];
  selfUid: string;
  error: string | null;
  disabled?: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
};

export function VoiceBar({
  inVoice,
  muted,
  joining,
  members,
  selfUid,
  error,
  disabled,
  onJoin,
  onLeave,
  onToggleMute,
}: Props) {
  const others = members.filter((member) => member.uid !== selfUid);

  return (
    <div className="flex items-center gap-2">
      {inVoice ? (
        <>
          <button
            type="button"
            onClick={onToggleMute}
            className={`p-2 rounded-lg transition-colors ${muted ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'}`}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onLeave}
            className="p-2 rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
            title="Leave voice"
          >
            <PhoneOff className="w-4 h-4" />
          </button>
          <span className="hidden sm:inline text-xs text-stone-500 max-w-[10rem] truncate" title={others.map((m) => m.name).join(', ')}>
            {members.length} in voice
            {others.length > 0 ? `: ${others.map((m) => m.name).join(', ')}` : ''}
          </span>
        </>
      ) : (
        <button
          type="button"
          onClick={onJoin}
          disabled={disabled || joining || members.length >= MAX_VOICE_PEERS}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-50"
          title="Join voice chat"
        >
          <Mic className="w-4 h-4 text-indigo-500" />
          <span className="text-sm font-medium">{joining ? 'Joining…' : 'Voice'}</span>
        </button>
      )}
      {error ? <span className="hidden md:inline text-xs text-rose-500 max-w-[12rem] truncate">{error}</span> : null}
    </div>
  );
}
