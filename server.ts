import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { createServer as createViteServer } from 'vite';

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
    },
  });
  const PORT = 3000;

  // Socket.io logic
  io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Join a specific room (e.g., based on video URL or a generic room)
    socket.on('joinRoom', (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room: ${roomId}`);
    });

    // Handle video state updates
    socket.on('videoStateChange', ({ roomId, state }) => {
      // Broadcast to everyone in the room EXCEPT the sender
      socket.to(roomId).emit('videoStateUpdate', state);
    });
    
    // Play video
    socket.on('video-play', ({ roomId, time }) => {
      socket.to(roomId).emit('video-play', time);
    });

    // Pause video
    socket.on('video-pause', ({ roomId, time }) => {
      socket.to(roomId).emit('video-pause', time);
    });

    // Seek video
    socket.on('seek', ({ roomId, time }) => {
      socket.to(roomId).emit('seek', time);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  // API Routes (if needed)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
