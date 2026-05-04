# LiveTrack — Real-time Location Sharing

A real-time live location tracking system built with **Node.js**, **Socket.IO**, **Kafka**, and **Leaflet**. Multiple authenticated users can share their GPS location and watch each other move on a live map.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js (ESM), Express 5 |
| Real-time | Socket.IO 4 |
| Message broker | Apache Kafka (KRaft mode via Docker) |
| Auth | Session-based (simulates OIDC — see note below) |
| Frontend | Vanilla JS, Leaflet.js |
| Package manager | npm / pnpm |

---

## Project Structure

```
├── index.js              # Main server — Express + Socket.IO + Kafka producer/consumer
├── database-processor.js # Separate Kafka consumer — batched DB writes
├── kafka-admin.js        # One-time topic setup
├── kafka-client.js       # Shared Kafka client (reads from .env)
├── auth.js               # Auth helpers — credential validation, requireAuth middleware
├── docker-compose.yml    # Single-node Kafka (KRaft)
├── public/
│   ├── index.html        # Main map app (protected)
│   └── login.html        # Login page
├── .env.example
└── README.md
```

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd kafka-learning
npm install
```

### 2. Environment variables

```bash
cp .env.example .env
# Edit .env — at minimum change SESSION_SECRET
```

### 3. Start Kafka

```bash
docker-compose up -d
```

Wait ~10 seconds for Kafka to be ready, then create the topic:

```bash
node kafka-admin.js
```

### 4. Start the servers

In two separate terminals:

```bash
# Terminal 1 — main server (Socket.IO + Kafka producer + socket-server consumer)
node index.js

# Terminal 2 — database processor (separate Kafka consumer group)
node database-processor.js
```

Open **http://localhost:8000** in your browser.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | HTTP server port |
| `SESSION_SECRET` | `dev-secret-…` | Express session signing secret |
| `KAFKA_BROKERS` | `127.0.0.1:9092` | Comma-separated Kafka broker list |
| `KAFKA_CLIENT_ID` | `livetrack` | Kafka client identifier |

---

## Demo Accounts

| Username | Password |
|---|---|
| alice | alice123 |
| bob | bob123 |
| carol | carol123 |

Open two browser windows (or use incognito) and log in as different users to see real-time updates.

---

## Socket Event Flow

```
Client                          Server
  |                               |
  |-- client:location:update ---> |  (with { latitude, longitude })
  |                               |-- validates input
  |                               |-- publishes to Kafka topic: location-updates
  |                               |
  |                    Kafka consumer (socket-server group)
  |                               |-- receives message
  |                               |-- deduplicates by eventId
  |<-- server:location:update --- |  (broadcast to all sockets)
  |<-- server:user:disconnected - |  (on disconnect or stale timeout)
  |<-- server:identity ---------- |  (on connect — tells client their userId)
  |<-- server:error ------------- |  (on invalid input)
```

---

## Kafka Event Flow

```
Socket.IO handler
  └─► kafkaProducer.send({ topic: 'location-updates', key: userId, value: JSON })

Topic: location-updates (2 partitions)
  │
  ├─► Consumer group: socket-server-8000
  │     └─► Broadcasts server:location:update to all Socket.IO clients
  │
  └─► Consumer group: database-processor
        └─► Buffers events → batch INSERT every 5 seconds
```

Happy Learning !