# KaroSync

> **Scan, Sync, Sing** — Turn any YouTube tab into a wireless karaoke stage.

KaroSync mengubah tab YouTube di browser desktop/TV menjadi panggung karaoke nirkabel menggunakan ponsel sebagai mikrofon *low-latency* melalui WebRTC P2P.

## Struktur Monorepo

| Workspace | Package | Stack | Status |
| :--- | :--- | :--- | :--- |
| `signaling-server/` | `@karosync/signaling` | Node.js, TypeScript, `ws`, Docker | **Fase 1–4 Selesai** |
| `client-web/` | `@karosync/client` | Vite, TypeScript, Tailwind CSS v4 | **Fase 1–4 Selesai** |
| `extension/` | `@karosync/extension` | Chrome Extension MV3, Vite, TypeScript, Tailwind CSS v4, Side Panel API | **Fase 1–4 Selesai** |

## Prasyarat

- **Node.js** >= 20 (diuji dengan Node `v24.x`)
- **npm** >= 10 (menggunakan npm workspaces bawaan)

## Instalasi & Perintah Utama

```bash
# Install semua dependensi workspace
npm install

# Jalankan Signaling Server (dev watch, default port 8080)
npm run dev:signaling

# Jalankan Mobile Web Mic Client (dev server, default port 5173 + proxy /ws ke 8080)
npm run dev:client

# Build watch Chrome Extension ke extension/dist
npm run dev:extension

# Typecheck seluruh workspace
npm run typecheck

# Build produksi seluruh workspace
npm run build

# Jalankan seluruh automated unit & cross-workspace integration tests
npm test

# Verifikasi penuh 1 perintah (typecheck + build + test)
npm run check
```

## Signaling Server (`@karosync/signaling`)

### Environment Variables

Lihat template di [signaling-server/.env.example](./signaling-server/.env.example).

| Variable | Default | Deskripsi |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Alamat bind server HTTP/WebSocket |
| `PORT` | `8080` | Port server HTTP/WebSocket |
| `MAX_CLIENTS_PER_ROOM` | `8` | Batas maksimal mic client per room (naikkan mis. ke `12` untuk >8 mic) |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Interval ping/pong heartbeat WebSocket (ms) |
| `ALLOWED_ORIGINS` | *(kosong = semua)* | Daftar origin WebSocket yang diizinkan, dipisah koma (mendukung wildcard seperti `chrome-extension://*`) |

### Health Check

Mendukung `GET /health` dan `HEAD /health` dengan header `Access-Control-Allow-Origin: *`:

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
| Host / Client → Server | `PING` | `{ "type": "PING", "ts"?: 1700000000000 }` |
| Server → Sender | `PONG` | `{ "type": "PONG", "ts"?: 1700000000000, "serverTime": 1700000000005 }` |
| Server → Sender | `ERROR` | `{ "type": "ERROR", "code": "...", "message": "..." }` |

## Mobile Web Mic Client (`@karosync/client`)

Aplikasi web *mobile-first* di `client-web/` untuk Android & iOS Safari agar ponsel berfungsi sebagai mikrofon nirkabel *low-latency*.

### Fitur Utama
- **Room & Status Connection**: Otomatis membaca `?room=<roomId>` (6 karakter) dari hasil scan QR maupun input manual, input `Nama Penyanyi` (1–32 karakter), dan indikator status `Connecting`, `Live on Air`, `Muted by Host`, serta `Disconnected`.
- **Low-Latency & Anti-Feedback Vocal Capture**: Default **Low-Latency** (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `latency: 0.01`, Opus 10ms framing) untuk jeda tercepat (~15 ms), plus opsi sekunder **Anti-Dengung (AEC)** jika diperlukan di ruangan sangat bergema, lengkap dengan *local audio visualizer* berbasis `AnalyserNode` (tanpa routing ke speaker lokal).
- **WebRTC P2P Sender**: `RTCPeerConnection` dengan fallback STUN `stun:stun.l.google.com:19302` (otomatis memprioritaskan kandidat LAN lokal) dan diagnostik jalur/RTT.
- **Mobile Safeguards**: **Screen Wake Lock API** dengan *auto re-acquire* saat `visibilitychange`, tombol **Self-Mute / Unmute** lokal (`audioTrack.enabled`), serta deteksi *secure context* (HTTPS).
- **Single-Tunnel Dev Proxy**: `vite.config.ts` mengizinkan host tunnel (`allowedHosts: true`) dan mem-proxy `/ws` + `/health` ke `signaling-server` lokal (`127.0.0.1:8080`).

### Konfigurasi URL & Environment

Lihat template di [client-web/.env.example](./client-web/.env.example).

| Sumber | Prioritas | Contoh | Deskripsi |
| :--- | :--- | :--- | :--- |
| Query `?room=` | 1 | `/?room=K7M2PX` | Kode room otomatis dari QR Code Operator |
| Query `?ws=` | 1 | `/?room=K7M2PX&ws=wss://sig.example.com` | Override alamat WebSocket Signaling Server otomatis dari QR |
| `VITE_SIGNALING_URL` | 2 | `wss://sig.example.com` | Environment variable saat build produksi |
| Auto Fallback | 3 | `ws(s)://<hostname>:8080` | Default otomatis mengikuti host halaman |

### Protokol DataChannel P2P (`karosync-control`)

| Arah | Event `type` | Payload |
| :--- | :--- | :--- |
| Host → Client | `HOST_MUTE` | `{ "type": "HOST_MUTE", "muted": true \| false }` |
| Client → Host | `SELF_MUTE` | `{ "type": "SELF_MUTE", "muted": true \| false }` |

## Chrome Extension Operator (`@karosync/extension`)

Ekstensi Google Chrome Manifest V3 (**KaroSync Operator**) di `extension/` berbasis Chrome Side Panel untuk mengelola room, mencampur audio dari banyak ponsel penyanyi secara *low-latency*, serta mengontrol volume tab YouTube tanpa ter-reset saat berpindah lagu.

### Fitur Utama
- **Room, Test Koneksi & QR Code**: Dilengkapi tombol **Test Koneksi Server** (uji konektivitas WebSocket + ping sebelum membuat room tanpa beban *polling* saat live), terhubung ke `@karosync/signaling` (`CREATE_ROOM`), menampilkan kode room 6 karakter, QR Code untuk **KaroSync Mic** (`qrcode`), tombol **Copy Mic Link** & **Salin Kode**, serta panel *Settings* dengan deteksi *Mixed Content* + tombol cepat proxy `/ws`.
- **YouTube Master & Quick Ducking**: Content Script (`*://www.youtube.com/*`) mengontrol `video.volume` (`SET_YT_VOLUME`) dan status tab aktif (`GET_YT_STATUS`), menahan volume operator agar tidak ter-reset saat YouTube berpindah lagu (SPA), serta **Quick Ducking (30%)** otomatis saat vokal aktif.
- **Multi-Peer WebRTC Receiver & Web Audio Mixer**: Mengelola banyak `RTCPeerConnection` paralel (`Map<clientId, PeerEntry>`), DataChannel `karosync-control` dua arah (`HOST_MUTE` / `SELF_MUTE`), tombol **Solo** per penyanyi & **Mute Semua** instan, serta bus **Web Audio API** (`AudioContext({ latencyHint: 'interactive' })`) dengan `MediaStreamAudioSourceNode` → `BiquadFilterNode` (High-Pass 120 Hz) → `GainNode` per mic → `AnalyserNode` (VU meter) → `Noise Gate GainNode` → `Master GainNode` → `DynamicsCompressorNode` → speaker/TV.
- **Anti-Feedback DSP & HDMI Audio Tuning**: Klik badge **DSP · Limiter** di panel *Active Mics* untuk menyetel **High-Pass Filter (120 Hz)**, **Noise Gate (Auto-Cut saat Diam)** + slider threshold, preset limiter (**Balanced `-18 dB / 8:1`** default, **TV Safe `-22 dB / 12:1`**, **Stage `-12 dB / 6:1`**), slider threshold limiter (`-36 dB` s.d. `-6 dB`), serta indikator *AudioContext Latency* (`ms`).

### Memuat Chrome Extension (Development)

1. Jalankan `npm run build` (atau `npm run dev:extension` untuk mode watch).
2. Buka `chrome://extensions` di Google Chrome.
3. Aktifkan **Developer mode** → klik **Load unpacked** → pilih folder `extension/dist`.
4. Buka tab YouTube, lalu klik ikon **KaroSync Operator** di toolbar Chrome untuk membuka Side Panel.
5. (Opsional) Atur `VITE_SIGNALING_URL` dan `VITE_CLIENT_URL` via [extension/.env.example](./extension/.env.example) atau langsung lewat tombol gerigi di Side Panel.

## Local HTTPS Testing (Android & iOS Safari)

Karena browser mobile mewajibkan HTTPS untuk `getUserMedia` dan Wake Lock, gunakan **1 tunnel HTTPS** saja memanfaatkan proxy `/ws` bawaan `client-web`:

```bash
# Terminal 1
npm run dev:signaling

# Terminal 2
npm run dev:client

# Terminal 3 (Cloudflare Quick Tunnel — gratis tanpa akun; alternatif: ngrok http 5173)
cloudflared tunnel --url http://localhost:5173
```

Kemudian di **Settings** Side Panel Chrome Extension:
1. Isi **Mic Client URL** dengan `https://<host-tunnel>`.
2. Klik tombol **"Pakai Proxy (`wss://<host-tunnel>/ws`)"** lalu klik **Simpan**.
3. Buat Session Room dan scan QR Code dari HP Android/iOS pada Wi-Fi yang sama.

## Production Deployment

Konfigurasi siap pakai telah tersedia di repositori:

- **`client-web` (Static HTTPS)**:
  - **Vercel**: [client-web/vercel.json](./client-web/vercel.json) (`Root Directory: client-web`, set `VITE_SIGNALING_URL=wss://...`).
  - **Cloudflare Pages**: [client-web/public/_headers](./client-web/public/_headers) (`Root directory: client-web`, `Build command: npm run build`, `Output: dist`).
- **`signaling-server` (Persistent WebSocket)**:
  - **Docker / VPS / Server Kantor**: [signaling-server/Dockerfile](./signaling-server/Dockerfile) + [.dockerignore](./.dockerignore) (build dari root: `docker build -f signaling-server/Dockerfile -t karosync-signaling .`).
  - **Fly.io**: [signaling-server/fly.toml](./signaling-server/fly.toml) (`fly deploy --config signaling-server/fly.toml --dockerfile signaling-server/Dockerfile`).
  - **Railway**: [signaling-server/railway.json](./signaling-server/railway.json).
- **`extension` (Chrome Operator)**:
  - Salin [extension/.env.example](./extension/.env.example) menjadi `extension/.env.production`, isi `VITE_SIGNALING_URL` & `VITE_CLIENT_URL`, lalu jalankan `npm run build --workspace=@karosync/extension`.
