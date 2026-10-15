import React from 'react';
import { ScreenShare, ScreenShareOff } from 'lucide-react';
import type { ScreenShareInfo } from '../lib/screenShare';

type Props = {
  presenting: boolean;
  presenter: ScreenShareInfo;
  starting: boolean;
  error: string | null;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
};

export function ScreenShareBar({
  presenting,
  presenter,
  starting,
  error,
  disabled,
  onStart,
  onStop,
}: Props) {
  const otherSharing = Boolean(presenter && !presenting);

  return (
    <div className="flex items-center gap-2">
      {presenting ? (
        <button
          type="button"
          onClick={onStop}
          className="flex items-center gap-2 min-h-11 px-3 py-1.5 rounded-lg bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400 hover:bg-rose-200 dark:hover:bg-rose-900/40"
          title="Stop sharing"
        >
          <ScreenShareOff className="w-4 h-4" />
          <span className="hidden sm:inline text-sm font-medium">Stop</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onStart}
          disabled={disabled || starting || otherSharing}
          className="flex items-center gap-2 min-h-11 px-3 py-1.5 rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-50"
          title={otherSharing ? `${presenter?.name} is sharing` : 'Share screen'}
        >
          <ScreenShare className="w-4 h-4 text-indigo-500" />
          <span className="hidden sm:inline text-sm font-medium">{starting ? 'Sharing…' : 'Share'}</span>
        </button>
      )}
      {error ? <span className="hidden md:inline text-xs text-rose-500 max-w-[12rem] truncate">{error}</span> : null}
    </div>
  );
}
