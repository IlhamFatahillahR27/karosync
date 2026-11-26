# KaroSync

> **Scan, Sync, Sing** — Turn any YouTube tab into a wireless karaoke stage.

KaroSync mengubah tab YouTube di browser desktop/TV menjadi panggung karaoke nirkabel menggunakan ponsel sebagai mikrofon *low-latency* melalui WebRTC P2P.

## Struktur Monorepo

| Workspace | Package | Stack | Status |
| :--- | :--- | :--- | :--- |
| `signaling-server/` | `@karosync/signaling` | Node.js, TypeScript, `ws` | **Fase 1 Selesai** |
| `client-web/` | `@karosync/client` | Vite, TypeScript, Tailwind CSS v4 | **Fase 2 Selesai** |
| `extension/` | `@karosync/extension` | Chrome Extension MV3, Vite, TypeScript, Tailwind CSS v4, Side Panel API | Scaffold (Fase 3) |

## Prasyarat

- **Node.js** >= 20 (diuji dengan Node `v24.x`)
- **npm** >= 10 (menggunakan npm workspaces bawaan)

## Instalasi & Perintah Utama

```bash
# Install semua dependensi workspace
npm install

# Jalankan Signaling Server (dev watch, default port 8080)
npm run dev:signaling

# Jalankan Mobile Web Mic Client (dev server, default port 5173)
npm run dev:client

# Build watch Chrome Extension ke extension/dist
npm run dev:extension

# Typecheck seluruh workspace
npm run typecheck

# Build produksi seluruh workspace
npm run build

# Jalankan automated tests seluruh workspace (signaling-server & client-web)
npm test
```

## Signaling Server (`@karosync/signaling`)

### Environment Variables

| Variable | Default | Deskripsi |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Alamat bind server HTTP/WebSocket |
| `PORT` | `8080` | Port server HTTP/WebSocket |
| `MAX_CLIENTS_PER_ROOM` | `8` | Batas maksimal mic client per room |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Interval ping/pong heartbeat WebSocket (ms) |

### Health Check

```bash
curl http://localhost:8080/health
# {"status":"ok","rooms":0,"clients":0,"connections":0,"uptime":12}
```

### Protokol WebSocket

| Arah | Event `type` | Payload |
| :--- | :--- | :--- |
| Host → Server | `CREATE_ROOM` | `{ "type": "CREATE_ROOM" }` |
| Server → Host | `ROOM_CREATED` | `{ "type": "ROOM_CREATED", "roomId": "K7M2PX" }` |
| Client → Server | `JOIN_ROOM` | `{ "type": "JOIN_ROOM", "roomId": "K7M2PX", "clientName": "Budi" }` |
| Server → Client | `ROOM_JOINED` | `{ "type": "ROOM_JOINED", "roomId": "K7M2PX", "clientId": "...", "clientName": "Budi" }` |
| Server → Host | `CLIENT_JOINED` | `{ "type": "CLIENT_JOINED", "roomId": "K7M2PX", "clientId": "...", "clientName": "Budi" }` |
| Host ↔ Client | `SIGNAL` | `{ "type": "SIGNAL", "targetId": "host" \| "<clientId>", "senderId": "...", "sdp"?, "candidate"? }` |
| Host → Server | `KICK_CLIENT` | `{ "type": "KICK_CLIENT", "clientId": "...", "reason"?: "..." }` |
| Server → Client | `KICKED` | `{ "type": "KICKED", "roomId": "...", "reason": "..." }` (close `4001`) |
| Server → Host | `CLIENT_LEFT` | `{ "type": "CLIENT_LEFT", "roomId": "...", "clientId": "...", "reason": "disconnected" \| "kicked" }` |
| Server → Client | `ROOM_CLOSED` | `{ "type": "ROOM_CLOSED", "roomId": "...", "reason": "Host disconnected" }` (close `4002`) |
| Server → Sender | `ERROR` | `{ "type": "ERROR", "code": "...", "message": "..." }` |

## Mobile Web Mic Client (`@karosync/client`)

Aplikasi web *mobile-first* di `client-web/` untuk Android & iOS Safari agar ponsel berfungsi sebagai mikrofon nirkabel *low-latency*.

### Fitur Utama
- **Room & Status Connection**: Otomatis membaca `?room=<roomId>` (6 karakter) dari hasil scan QR maupun input manual, input `Nama Penyanyi` (1–32 karakter), dan indikator status `Connecting`, `Live on Air`, `Muted by Host`, serta `Disconnected`.
- **Low-Latency Vocal Capture**: `getUserMedia` dengan `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `latency: 0.01` (dengan fallback otomatis bila browser tidak mendukung properti `latency`), serta *local audio visualizer* berbasis `AnalyserNode` (tanpa routing ke speaker lokal).
- **WebRTC P2P Sender**: `RTCPeerConnection` dengan fallback STUN `stun:stun.l.google.com:19302` (otomatis memprioritaskan kandidat LAN lokal) dan diagnostik jalur/RTT.
- **Mobile Safeguards**: **Screen Wake Lock API** dengan *auto re-acquire* saat `visibilitychange`, tombol **Self-Mute / Unmute** lokal (`audioTrack.enabled`), serta deteksi *secure context* (HTTPS).

### Konfigurasi URL & Environment

| Sumber | Prioritas | Contoh | Deskripsi |
| :--- | :--- | :--- | :--- |
| Query `?room=` | 1 | `/?room=K7M2PX` | Kode room otomatis dari QR Code Operator |
| Query `?ws=` | 1 | `/?room=K7M2PX&ws=wss://sig.example.com` | Override alamat WebSocket Signaling Server |
| Panel *Server Settings* | 2 | Disimpan di `localStorage` | Override manual opsional di UI join |
| `VITE_SIGNALING_URL` | 3 | `wss://sig.example.com` | Environment variable saat build produksi |
| Auto Fallback | 4 | `ws(s)://<hostname>:8080` | Default otomatis mengikuti host halaman |

### Protokol DataChannel P2P (`karosync-control`)

Selain jalur audio WebRTC, client membuka `RTCDataChannel` berlabel `karosync-control` (dan juga menerima `ondatachannel` dari Host) untuk sinkronisasi status mute langsung P2P:

| Arah | Event `type` | Payload |
| :--- | :--- | :--- |
| Host → Client | `HOST_MUTE` | `{ "type": "HOST_MUTE", "muted": true \| false }` |
| Client → Host | `SELF_MUTE` | `{ "type": "SELF_MUTE", "muted": true \| false }` |

## Memuat Chrome Extension (Development)

1. Jalankan `npm run build` (atau `npm run dev:extension` untuk mode watch).
2. Buka `chrome://extensions` di Google Chrome.
3. Aktifkan **Developer mode** → klik **Load unpacked** → pilih folder `extension/dist`.
4. Klik ikon **KaroSync Operator** di toolbar Chrome untuk membuka Side Panel.

