import { kafkaClient } from './kafka-client.js';

const FLUSH_INTERVAL = 5_000; // flush batch every 5 seconds
const MAX_HISTORY_PER_USER = 100; // keep last N points per user in memory

// ── In-memory location history (simulates a DB table) ───────────────────────
// Map<userId, Array<{ latitude, longitude, timestamp }>>
const locationHistory = new Map();

function recordToHistory(userId, point) {
  if (!locationHistory.has(userId)) locationHistory.set(userId, []);
  const history = locationHistory.get(userId);
  history.push(point);
  // Trim to last MAX_HISTORY_PER_USER entries
  if (history.length > MAX_HISTORY_PER_USER) {
    history.splice(0, history.length - MAX_HISTORY_PER_USER);
  }
}

// ── Simulated DB write ───────────────────────────────────────────────────────
async function simulateDbWrite(batch) {
  // In production: INSERT INTO location_history (user_id, lat, lng, ts) VALUES ...
  console.log(`[DB] Batch INSERT — ${batch.length} location record(s)`);
  for (const row of batch) {
    console.log(
      `[DB]   user=${row.userId} (${row.displayName}) ` +
      `lat=${row.latitude.toFixed(5)} lng=${row.longitude.toFixed(5)} ` +
      `ts=${row.timestamp}`,
    );
    recordToHistory(row.userId, {
      latitude: row.latitude,
      longitude: row.longitude,
      timestamp: row.timestamp,
    });
  }
  // Simulate async DB latency
  await new Promise((r) => setTimeout(r, 10));
}

// ── Batch buffer ─────────────────────────────────────────────────────────────
let locationBuffer = [];

function flushBuffer() {
  if (locationBuffer.length === 0) return;
  const batch = locationBuffer.splice(0); // drain buffer
  simulateDbWrite(batch).catch((err) =>
    console.error('[DB] Batch write failed:', err.message),
  );
}

setInterval(flushBuffer, FLUSH_INTERVAL);

// ── Kafka consumer ────────────────────────────────────────────────────────────
async function init() {
  const kafkaConsumer = kafkaClient.consumer({
    groupId: 'database-processor',
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });

  await kafkaConsumer.connect();
  console.log('[DB-Processor] Kafka consumer connected');

  await kafkaConsumer.subscribe({
    topics: ['location-updates'],
    fromBeginning: false,
  });

  await kafkaConsumer.run({
    eachMessage: async ({ message, heartbeat }) => {
      try {
        const data = JSON.parse(message.value.toString());

        // Basic validation before buffering
        if (
          !data.userId ||
          typeof data.latitude !== 'number' ||
          typeof data.longitude !== 'number'
        ) {
          console.warn('[DB-Processor] Skipping malformed message:', data);
          await heartbeat();
          return;
        }

        locationBuffer.push({
          userId: data.userId,
          displayName: data.displayName ?? data.userId,
          latitude: data.latitude,
          longitude: data.longitude,
          timestamp: data.timestamp ?? new Date().toISOString(),
        });

        console.log(
          `[DB-Processor] Buffered location for ${data.displayName ?? data.userId} ` +
          `(buffer size: ${locationBuffer.length})`,
        );
      } catch (err) {
        console.error('[DB-Processor] Failed to parse message:', err.message);
      }
      await heartbeat();
    },
  });

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[DB-Processor] ${signal} — shutting down`);
    flushBuffer(); // flush remaining events
    await kafkaConsumer.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

init().catch((err) => {
  console.error('[DB-Processor] Fatal error:', err);
  process.exit(1);
});
