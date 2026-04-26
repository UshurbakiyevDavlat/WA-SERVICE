# wa-service

Self-hosted WhatsApp multi-session HTTP API service built on [Baileys](https://github.com/WhiskeySockets/Baileys). Drop-in replacement for [WAHA](https://github.com/devlikeapro/waha) with a compatible API — run it yourself, no subscriptions.

## Features

- **Multi-session** — each session is an independent phone number with its own credentials
- **WAHA-compatible API** — swap the base URL, everything else works as-is
- **QR auth** — scan once, credentials are persisted across restarts
- **Webhooks** — incoming messages are forwarded to your backend in WAHA payload format
- **Auto-reconnect** — exponential backoff on connection drops, FAILED state on logout
- **API key auth** — optional `X-Api-Key` header guard
- **Docker-ready** — single container, sessions directory as a volume

## Quick Start

### With Docker (recommended)

```bash
docker build -t wa-service .

docker run -d \
  --name wa-service \
  -p 3000:3000 \
  -v $(pwd)/sessions:/app/sessions \
  -e WAHA_API_KEY=your-secret-key \
  wa-service
```

### Local (Node 20+)

```bash
npm install
WAHA_API_KEY=your-secret-key npm start
```

Dev mode with auto-reload:

```bash
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `WAHA_API_KEY` | _(empty)_ | API key for `X-Api-Key` header. If not set — open access (dev mode) |
| `SESSIONS_DIR` | `./sessions` | Directory for persisting session credentials |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`, `silent`) |

## API Reference

All endpoints require `X-Api-Key: <key>` header if `WAHA_API_KEY` is configured.

### Health

```
GET /health
```

Returns service status and number of active sessions.

```json
{ "status": "ok", "sessions": 2 }
```

---

### Sessions

#### Get session status

```
GET /api/sessions/:session
```

Returns `404` if session doesn't exist (same as WAHA).

```json
{ "name": "default", "status": "WORKING", "me": { "id": "77771234567@s.whatsapp.net", "name": "John" } }
```

**Statuses:** `STOPPED` → `STARTING` → `SCAN_QR_CODE` → `WORKING` (or `FAILED` on logout)

---

#### Create / configure session

```
PUT /api/sessions/:session
Body: { "config": { "webhooks": [{ "url": "https://your-backend/webhook" }] } }
```

Creates the session (if not exists), sets the webhook URL, and starts connecting.

---

#### Start session

```
POST /api/sessions/:session/start
```

Starts an already-configured session. If already running — returns current status (no error).

---

#### Stop session

```
POST /api/sessions/:session/stop
```

Stops the session, logs out from WhatsApp, and **deletes credentials**. Next `start` will show a new QR.

---

#### Logout (recovery)

```
POST /api/sessions/:session/logout
```

Same as `stop` but keeps the session object in memory. Use when a session is in `FAILED` state — after logout, call `start` to get a fresh QR.

---

#### List all sessions

```
GET /api/sessions
```

Returns array of all session status objects.

---

### QR Code

```
GET /api/:session/auth/qr
```

Available only when session is in `SCAN_QR_CODE` state. Returns QR as base64 PNG data URL.

```json
{ "image": "data:image/png;base64,iVBORw0KGgo..." }
```

---

### Sending Messages

```
POST /api/sendText
Body: { "session": "default", "chatId": "77771234567@c.us", "text": "Hello!" }
```

`chatId` formats:
- Personal chat: `<phone>@c.us` (e.g. `77771234567@c.us`)
- New-style accounts: `<id>@lid`

Returns `{ "success": true }` or `500` with error if session is not in `WORKING` state.

---

## Webhook Payload

Incoming messages are forwarded to your configured webhook URL in WAHA-compatible format:

```json
{
  "event": "message",
  "session": "default",
  "payload": {
    "from": "77771234567@c.us",
    "fromMe": false,
    "hasMedia": false,
    "body": "Hello!",
    "pushName": "John",
    "_data": {
      "notifyName": "John",
      "key": {
        "remoteJid": "77771234567@c.us",
        "fromMe": false,
        "id": "ABCDEF123456"
      }
    }
  }
}
```

Filtered out automatically: group messages (`@g.us`), broadcasts, media-only messages, and outgoing messages (`fromMe: true`).

---

## Session Lifecycle

```
STOPPED
  │  start() called
  ▼
STARTING
  │  Baileys socket created, connecting...
  ▼
SCAN_QR_CODE       ← GET /api/:session/auth/qr available here
  │  QR scanned
  ▼
WORKING            ← sendText available here
  │
  ├─ network drop → STARTING → auto-reconnect (5s, 10s, ... up to 60s)
  │
  └─ user logs out in WA app → FAILED → logout() + start() to recover
```

Credentials are stored in `SESSIONS_DIR/<session-name>/`. Persisting this directory (e.g. as a Docker volume) means sessions survive restarts without rescanning QR.

---

## Docker Compose Example

```yaml
services:
  wa-service:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./sessions:/app/sessions
    environment:
      WAHA_API_KEY: your-secret-key
      LOG_LEVEL: info
    restart: unless-stopped
```

---

## Differences from WAHA

| Feature | WAHA Free | WAHA Plus ($19/mo) | wa-service |
|---|---|---|---|
| Multi-session | ❌ 1 session | ✅ unlimited | ✅ unlimited |
| Self-hosted | ✅ | ✅ | ✅ |
| QR auth | ✅ | ✅ | ✅ |
| Webhooks | ✅ | ✅ | ✅ |
| Send text | ✅ | ✅ | ✅ |
| Send media | ❌ | ✅ | ❌ (planned) |
| REST swagger docs | ✅ | ✅ | ❌ |
| Price | Free | $19/mo | Free |

---

## Tech Stack

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web reverse-engineered client
- **Express** — HTTP server
- **Pino** — structured logging
- **QRCode** — QR image generation
- **Axios** — webhook delivery
