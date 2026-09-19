import { lazy, type ComponentType } from 'react';
import { createReactPlayer } from 'react-player/ReactPlayer';
import HtmlPlayer from 'react-player/HtmlPlayer';
import { canPlay } from 'react-player/patterns';
import type { PlayerEntry } from 'react-player/players';

function lazyPlayer(loader: () => Promise<{ default: ComponentType<unknown> }>): PlayerEntry['player'] {
  return lazy(loader) as unknown as PlayerEntry['player'];
}

const players: PlayerEntry[] = [
  {
    key: 'hls',
    name: 'hls.js',
    canPlay: canPlay.hls,
    canEnablePIP: () => true,
    player: lazyPlayer(() => import('hls-video-element/react')),
  },
  {
    key: 'youtube',
    name: 'YouTube',
    canPlay: canPlay.youtube,
    player: lazyPlayer(() => import('youtube-video-element/react')),
  },
  {
    key: 'vimeo',
    name: 'Vimeo',
    canPlay: canPlay.vimeo,
    player: lazyPlayer(() => import('vimeo-video-element/react')),
  },
  {
    key: 'wistia',
    name: 'Wistia',
    canPlay: canPlay.wistia,
    canEnablePIP: () => true,
    player: lazyPlayer(() => import('wistia-video-element/react')),
  },
  {
    key: 'html',
    name: 'html',
    canPlay: canPlay.html,
    canEnablePIP: () => true,
    player: HtmlPlayer,
  },
];

const ReactPlayer = createReactPlayer(players, players[players.length - 1]);
export default ReactPlayer;
