import http from 'node:http';
import path from 'node:path';

import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';

import { kafkaClient } from './kafka-client.js';
import { validateCredentials, requireAuth } from './auth.js';

// ── Seen-event deduplication window (ms) ────────────────────────────────────
const DEDUP_TTL = 5_000;
const seenEvents = new Map(); // eventId → timestamp

function isDuplicate(eventId) {
  const now = Date.now();
  // Purge old entries
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

// ── Stale-user tracking ──────────────────────────────────────────────────────
// userId → { socketId, lastSeen }
const activeUsers = new Map();
const STALE_TIMEOUT = 60_000; // remove user from map after 60 s of silence

function markUserSeen(userId, socketId) {
  activeUsers.set(userId, { socketId, lastSeen: Date.now() });
}

function removeStaleUsers(io) {
  const now = Date.now();
  for (const [userId, info] of activeUsers) {
    if (now - info.lastSeen > STALE_TIMEOUT) {
      activeUsers.delete(userId);
      io.emit('server:user:disconnected', { userId });
      console.log(`[Stale] Removed user ${userId} from active map`);
    }
  }
}

// ── Input validation ─────────────────────────────────────────────────────────
function isValidLocation(latitude, longitude) {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    isFinite(latitude) &&
    isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 &&
    longitude >= -180 && longitude <= 180
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const PORT = process.env.PORT ?? 8000;
  const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-change-in-production';

  const app = express();
  const server = http.createServer(app);

  // ── Session middleware ─────────────────────────────────────────────────────
  const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    },
  });

  app.use(cookieParser());
  app.use(sessionMiddleware);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Auth routes ────────────────────────────────────────────────────────────
  app.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    res.sendFile(path.resolve('./public/login.html'));
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = validateCredentials(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    req.session.user = user;
    return res.json({ ok: true, user });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });

  // Current user info (used by frontend to bootstrap)
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.session.user });
  });

  // ── Protected static files ─────────────────────────────────────────────────
  // Serve index.html only to authenticated users
  app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.resolve('./public/index.html'));
  });

  app.use('/assets', requireAuth, express.static(path.resolve('./public/assets')));

  // Public static (login page assets, socket.io client, leaflet etc.)
  app.use(express.static(path.resolve('./public')));

  app.get('/health', (req, res) => res.json({ healthy: true }));

  // ── Kafka producer ─────────────────────────────────────────────────────────
  const kafkaProducer = kafkaClient.producer({
    allowAutoTopicCreation: false,
    transactionTimeout: 30_000,
  });
  await kafkaProducer.connect();
  console.log('[Kafka] Producer connected');

  // ── Kafka consumer (socket-server group) ──────────────────────────────────
  const kafkaConsumer = kafkaClient.consumer({
    groupId: `socket-server-${PORT}`,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topics: ['location-updates'], fromBeginning: false });
  console.log('[Kafka] Socket-server consumer connected');

  // ── Socket.IO ──────────────────────────────────────────────────────────────
  const io = new Server(server, {
    cors: { origin: false },
  });

  // Share express-session with Socket.IO so we can read req.session.user
  io.engine.use(sessionMiddleware);

  // Socket auth middleware — reject unauthenticated connections
  io.use((socket, next) => {
    const session = socket.request.session;
    if (!session?.user) {
      return next(new Error('Unauthenticated'));
    }
    // Attach user to socket for easy access
    socket.user = session.user;
    next();
  });

  // ── Kafka → Socket broadcast ───────────────────────────────────────────────
  kafkaConsumer.run({
    eachMessage: async ({ message, heartbeat }) => {
      try {
        const data = JSON.parse(message.value.toString());

        // Deduplication: skip if we've seen this eventId recently
        if (data.eventId && isDuplicate(data.eventId)) {
          console.log(`[Kafka] Duplicate event skipped: ${data.eventId}`);
          await heartbeat();
          return;
        }

        console.log('[Kafka→Socket] Broadcasting location update', {
          userId: data.userId,
          displayName: data.displayName,
        });

        io.emit('server:location:update', {
          userId: data.userId,
          displayName: data.displayName,
          latitude: data.latitude,
          longitude: data.longitude,
          timestamp: data.timestamp,
        });

        markUserSeen(data.userId, data.socketId);
      } catch (err) {
        console.error('[Kafka→Socket] Failed to process message:', err.message);
      }
      await heartbeat();
    },
  });

  // Stale user cleanup every 30 s
  setInterval(() => removeStaleUsers(io), 30_000);

  // ── Socket connection handler ──────────────────────────────────────────────
  io.on('connection', (socket) => {
    const { id: userId, username, displayName } = socket.user;
    console.log(`[Socket] ${displayName} (${userId}) connected — socket ${socket.id}`);

    // Tell the newly connected client who they are
    socket.emit('server:identity', { userId, username, displayName });

    socket.on('client:location:update', async (locationData) => {
      // Validate input
      const { latitude, longitude } = locationData ?? {};
      if (!isValidLocation(latitude, longitude)) {
        socket.emit('server:error', { message: 'Invalid location data.' });
        console.warn(`[Socket] Invalid location from ${displayName}:`, locationData);
        return;
      }

      const event = {
        eventId: `${userId}-${Date.now()}`,
        socketId: socket.id,
        userId,
        username,
        displayName,
        latitude,
        longitude,
        timestamp: new Date().toISOString(),
      };

      console.log(`[Socket→Kafka] Publishing location for ${displayName}`);

      try {
        await kafkaProducer.send({
          topic: 'location-updates',
          messages: [
            {
              // Partition by userId so all events for a user go to the same partition
              key: userId,
              value: JSON.stringify(event),
            },
          ],
        });
      } catch (err) {
        console.error('[Kafka] Producer send failed:', err.message);
        socket.emit('server:error', { message: 'Failed to publish location. Try again.' });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] ${displayName} disconnected — ${reason}`);
      // Notify others that this user went offline
      io.emit('server:user:disconnected', { userId });
      activeUsers.delete(userId);
    });

    socket.on('error', (err) => {
      console.error(`[Socket] Error from ${displayName}:`, err.message);
    });
  });

  // ── Start server ───────────────────────────────────────────────────────────
  server.listen(PORT, () =>
    console.log(`[Server] Running on http://localhost:${PORT}`),
  );

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  async function shutdown(signal) {
    console.log(`\n[Server] ${signal} received — shutting down gracefully`);
    await kafkaProducer.disconnect();
    await kafkaConsumer.disconnect();
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
