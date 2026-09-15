import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { createServer as createViteServer } from 'vite';

type RoomPlayback = {
  url?: string;
  time: number;
  playing: boolean;
};

function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
    },
  });
  const PORT = 3000;
  const roomPlayback = new Map<string, RoomPlayback>();

  const patchRoom = (roomId: string, patch: Partial<RoomPlayback>) => {
    const prev = roomPlayback.get(roomId) ?? { time: 0, playing: false };
    const next = { ...prev, ...patch };
    roomPlayback.set(roomId, next);
    return next;
  };

  const emitUserCount = (roomId: string) => {
    const count = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    io.to(roomId).emit('room-users', count);
  };

  io.on('connection', (socket) => {
    let currentRoom: string | null = null;

    socket.on('joinRoom', (roomId) => {
      if (!isRoomId(roomId)) return;

      if (currentRoom && currentRoom !== roomId) {
        socket.leave(currentRoom);
        emitUserCount(currentRoom);
      }

      currentRoom = roomId;
      socket.join(roomId);

      const state = roomPlayback.get(roomId);
      if (state) {
        socket.emit('roomState', state);
      }

      emitUserCount(roomId);
    });

    socket.on('videoStateUpdate', ({ roomId, state }) => {
      if (!isRoomId(roomId) || !state || typeof state !== 'object') return;
      const url = typeof state.url === 'string' ? state.url : undefined;
      patchRoom(roomId, { url, time: 0, playing: false });
      socket.to(roomId).emit('videoStateUpdate', { url });
    });

    socket.on('video-play', ({ roomId, time }) => {
      if (!isRoomId(roomId) || !isFiniteNumber(time)) return;
      patchRoom(roomId, { time, playing: true });
      socket.to(roomId).emit('video-play', time);
    });

    socket.on('video-pause', ({ roomId, time }) => {
      if (!isRoomId(roomId) || !isFiniteNumber(time)) return;
      patchRoom(roomId, { time, playing: false });
      socket.to(roomId).emit('video-pause', time);
    });

    socket.on('seek', ({ roomId, time }) => {
      if (!isRoomId(roomId) || !isFiniteNumber(time)) return;
      patchRoom(roomId, { time });
      socket.to(roomId).emit('seek', time);
    });

    socket.on('video-sync', ({ roomId, time, playing }) => {
      if (!isRoomId(roomId) || !isFiniteNumber(time) || typeof playing !== 'boolean') return;
      patchRoom(roomId, { time, playing });
    });

    socket.on('chat-message', ({ roomId, message }) => {
      if (!isRoomId(roomId) || !message || typeof message !== 'object') return;
      socket.to(roomId).emit('chat-message', message);
    });

    socket.on('disconnect', () => {
      if (currentRoom) {
        emitUserCount(currentRoom);
      }
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
