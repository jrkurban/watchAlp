import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import fs from 'fs';

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
    },
  });
  const PORT = 3000;

  // Setup Multer for video uploads
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
  }

  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadsDir)
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      cb(null, uniqueSuffix + path.extname(file.originalname))
    }
  });
  const upload = multer({ storage: storage });

  // Serve uploads folder statically
  app.use('/uploads', express.static(uploadsDir));

  // Video Upload Endpoint
  app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }
    const videoUrl = `/uploads/${req.file.filename}`;
    res.json({ url: videoUrl });
  });

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
