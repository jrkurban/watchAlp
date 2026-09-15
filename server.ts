import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createVisitorStore, getClientIp } from './visitor-log';

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
  app.set('trust proxy', true);
  app.use(express.json());

  const server = createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
    },
  });
  const PORT = 3000;
  const LOGS_KEY = process.env.LOGS_KEY || 'syncwatch-logs';
  const visitors = createVisitorStore();
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
    const ip = getClientIp(socket.handshake.headers as Record<string, unknown>, socket.handshake.address);
    const userAgent = String(socket.handshake.headers['user-agent'] ?? '');

    socket.on('joinRoom', (roomId) => {
      if (!isRoomId(roomId)) return;

      if (currentRoom && currentRoom !== roomId) {
        socket.leave(currentRoom);
        emitUserCount(currentRoom);
      }

      currentRoom = roomId;
      socket.join(roomId);
      void visitors.touch({ ip, userAgent, roomId });

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

  app.post('/api/session', async (req, res) => {
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : null;
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;
    const record = await visitors.touch({
      sessionId,
      ip: getClientIp(req.headers as Record<string, unknown>, req.socket.remoteAddress ?? ''),
      userAgent: String(req.headers['user-agent'] ?? ''),
      roomId,
    });
    res.json({ id: record.id });
  });

  app.post('/api/session/heartbeat', async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : undefined;
    const record = await visitors.heartbeat(id, roomId);
    if (!record) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ id: record.id });
  });

  app.post('/api/session/leave', async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    await visitors.leave(id);
    res.json({ ok: true });
  });

  app.get('/api/logs', async (req, res) => {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (key !== LOGS_KEY) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ visitors: await visitors.list() });
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
    console.log(`Visitor logs: http://localhost:${PORT}/logs?key=${LOGS_KEY}`);
  });
}

startServer();
