import QRCode from 'qrcode';
import {
  MAX_COMPRESSOR_THRESHOLD_DB,
  MIN_COMPRESSOR_THRESHOLD_DB,
  type BuiltInCompressorPresetId,
} from './audio-mixer';
import {
  deriveTunnelSignalingUrl,
  detectMixedContentQrWarning,
  getDefaultSettings,
} from './config';
import type {
  OperatorSession,
  OperatorState,
  PeerMicState,
  RoomStatus,
} from './operator-session';

export interface KaroSyncOperatorUIOptions {
  root: HTMLElement;
  session: OperatorSession;
}

interface PeerCardRefs {
  card: HTMLElement;
  nameEl: HTMLElement;
  statusPill: HTMLElement;
  routeEl: HTMLElement;
  vuFill: HTMLElement;
  vuPeakDot: HTMLElement;
  volumeSlider: HTMLInputElement;
  volumeLabel: HTMLElement;
  muteBtn: HTMLButtonElement;
  kickBtn: HTMLButtonElement;
}

const ROOM_STATUS_META: Record<
  RoomStatus,
  { label: string; pillClass: string; dotClass: string }
> = {
  idle: {
    label: 'Offline',
    pillClass: 'border-slate-700/80 bg-slate-800/80 text-slate-300',
    dotClass: 'bg-slate-400',
  },
  connecting: {
    label: 'Connecting',
    pillClass: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
    dotClass: 'bg-sky-400 animate-pulse',
  },
  live: {
    label: 'Room Live',
    pillClass: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    dotClass: 'bg-emerald-400 live-pulse',
  },
  error: {
    label: 'Disconnected',
    pillClass: 'border-rose-500/50 bg-rose-500/15 text-rose-300',
    dotClass: 'bg-rose-400',
  },
};

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function getPeerStatusBadge(peer: PeerMicState): { label: string; className: string } {
  if (peer.hostMuted) {
    return {
      label: 'Muted by Host',
      className: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
    };
  }
  if (peer.selfMuted) {
    return {
      label: 'Self-Muted',
      className: 'border-slate-600 bg-slate-800 text-slate-300',
    };
  }
  if (peer.connectionState === 'connected') {
    return {
      label: 'Live',
      className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
    };
  }
  if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
    return {
      label: 'Reconnecting',
      className: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
    };
  }
  return {
    label: 'Connecting',
    className: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
  };
}

export class KaroSyncOperatorUI {
  private readonly session: OperatorSession;
  private readonly unsubscribe: () => void;
  private readonly peerCards = new Map<string, PeerCardRefs>();

  private lastRenderedQrUrl: string | null = null;
  private rafId: number | null = null;
  private copyLinkTimer: ReturnType<typeof setTimeout> | null = null;
  private copyCodeTimer: ReturnType<typeof setTimeout> | null = null;

  // Header & Settings elements
  private readonly statusPill: HTMLElement;
  private readonly statusDot: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly settingsToggleBtn: HTMLButtonElement;
  private readonly settingsDrawer: HTMLElement;
  private readonly settingsForm: HTMLFormElement;
  private readonly signalingInput: HTMLInputElement;
  private readonly clientUrlInput: HTMLInputElement;
  private readonly includeWsCheckbox: HTMLInputElement;
  private readonly settingsMixedWarningEl: HTMLElement;
  private readonly settingsMixedWarningText: HTMLElement;
  private readonly useTunnelWsBtn: HTMLButtonElement;
  private readonly settingsResetBtn: HTMLButtonElement;
  private readonly settingsErrorEl: HTMLElement;
  private readonly audioBanner: HTMLElement;
  private readonly resumeAudioBtn: HTMLButtonElement;

  // Lobby vs Active Room views
  private readonly lobbyView: HTMLElement;
  private readonly lobbyStatusDetail: HTMLElement;
  private readonly lobbyErrorBox: HTMLElement;
  private readonly lobbyErrorText: HTMLElement;
  private readonly createRoomBtn: HTMLButtonElement;
  private readonly activeRoomView: HTMLElement;

  // Section 1: Room & QR
  private readonly roomErrorBox: HTMLElement;
  private readonly roomErrorText: HTMLElement;
  private readonly qrMixedWarningBox: HTMLElement;
  private readonly qrMixedWarningText: HTMLElement;
  private readonly roomStatusDetail: HTMLElement;
  private readonly roomCodeText: HTMLElement;
  private readonly copyCodeBtn: HTMLButtonElement;
  private readonly qrCanvas: HTMLCanvasElement;
  private readonly joinUrlPreview: HTMLElement;
  private readonly copyLinkBtn: HTMLButtonElement;
  private readonly exitRoomTopBtn: HTMLButtonElement;
  private readonly exitRoomFooterBtn: HTMLButtonElement;

  // Section 2: YouTube Master
  private readonly ytStatusDot: HTMLElement;
  private readonly ytTitleEl: HTMLElement;
  private readonly ytVolumeSlider: HTMLInputElement;
  private readonly ytVolumeValue: HTMLElement;
  private readonly ytDuckedBadge: HTMLElement;
  private readonly duckingToggle: HTMLInputElement;

  // Section 3: Active Mics
  private readonly micCountBadge: HTMLElement;
  private readonly limiterBadge: HTMLButtonElement;
  private readonly limiterPanel: HTMLElement;
  private readonly audioLatencyBadge: HTMLElement;
  private readonly presetButtons: Map<BuiltInCompressorPresetId, HTMLButtonElement>;
  private readonly limiterThresholdSlider: HTMLInputElement;
  private readonly limiterThresholdValue: HTMLElement;
  private readonly masterVocalSlider: HTMLInputElement;
  private readonly masterVocalValue: HTMLElement;
  private readonly micsEmptyState: HTMLElement;
  private readonly micsListEl: HTMLElement;

  constructor(options: KaroSyncOperatorUIOptions) {
    this.session = options.session;

    options.root.innerHTML = `
      <main class="flex min-h-screen flex-col gap-3.5 p-3.5 pb-6">
        <!-- Header -->
        <header class="rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-lg shadow-slate-950/50">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-[11px] font-bold tracking-[0.18em] text-violet-400 uppercase">
                KaroSync Operator
              </p>
              <h1 class="truncate text-base font-bold text-white">Wireless Karaoke Stage</h1>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <span
                id="room-status-pill"
                class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
              >
                <span id="room-status-dot" class="h-2 w-2 rounded-full"></span>
                <span id="room-status-label">Offline</span>
              </span>
              <button
                id="settings-toggle-btn"
                type="button"
                title="Pengaturan Server & URL"
                class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-800/80 text-slate-300 transition hover:border-violet-500/60 hover:text-white cursor-pointer"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Collapsible Settings Drawer -->
          <div id="settings-drawer" class="mt-3 hidden border-t border-slate-800 pt-3">
            <form id="settings-form" class="flex flex-col gap-2.5">
              <div>
                <label for="signaling-url-input" class="block text-[11px] font-medium text-slate-300">
                  Signaling Server URL (WebSocket)
                </label>
                <input
                  id="signaling-url-input"
                  type="url"
                  placeholder="ws://localhost:8080"
                  class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-violet-500 focus:outline-none"
                />
              </div>
              <div>
                <label for="client-url-input" class="block text-[11px] font-medium text-slate-300">
                  KaroSync Mic Client URL (QR Target)
                </label>
                <input
                  id="client-url-input"
                  type="url"
                  placeholder="https://mic.example.com"
                  class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-violet-500 focus:outline-none"
                />
              </div>
              <label class="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
                <input
                  id="include-ws-checkbox"
                  type="checkbox"
                  class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-950 accent-violet-500"
                />
                Sertakan <code>&amp;ws=</code> di QR Code agar HP otomatis terhubung
              </label>
              <div
                id="settings-mixed-warning"
                class="hidden rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200"
              >
                <p id="settings-mixed-warning-text"></p>
                <button
                  id="use-tunnel-ws-btn"
                  type="button"
                  class="mt-2 hidden rounded-lg border border-amber-400/50 bg-amber-500/20 px-2.5 py-1 text-[10px] font-semibold text-amber-100 hover:bg-amber-500/30 cursor-pointer"
                >
                  Pakai Proxy Tunnel (/ws)
                </button>
              </div>
              <p id="settings-error" class="hidden text-[11px] text-rose-400"></p>
              <div class="flex items-center justify-end gap-2 pt-0.5">
                <button
                  id="settings-reset-btn"
                  type="button"
                  class="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Reset Default
                </button>
                <button
                  type="submit"
                  class="rounded-lg bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 cursor-pointer"
                >
                  Simpan
                </button>
              </div>
            </form>
          </div>
        </header>

        <!-- Audio Suspended Banner -->
        <div
          id="audio-suspended-banner"
          class="hidden flex items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-200"
        >
          <span>Output audio mixer sedang dijeda oleh browser.</span>
          <button
            id="resume-audio-btn"
            type="button"
            class="shrink-0 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-amber-400 cursor-pointer"
          >
            Aktifkan Audio
          </button>
        </div>

        <!-- Lobby View (Before Room Created) -->
        <section
          id="lobby-view"
          class="flex flex-1 flex-col justify-center rounded-2xl border border-slate-800 bg-slate-900/80 p-5 text-center"
        >
          <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/15 text-violet-300">
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </div>
          <h2 class="mt-3 text-base font-bold text-white">Mulai Session Room Karaoke</h2>
          <p id="lobby-status-detail" class="mt-1.5 text-xs leading-relaxed text-slate-400">
            Buat session room terlebih dahulu untuk menampilkan QR Code, kontrol musik YouTube Master, dan mixer Active Mics.
          </p>

          <div
            id="lobby-error-box"
            class="mt-3 hidden rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-left text-xs text-rose-200"
          >
            <p id="lobby-error-text"></p>
          </div>

          <button
            id="create-room-btn"
            type="button"
            class="mt-4 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-violet-950/50 transition hover:bg-violet-500 active:scale-[0.99] disabled:opacity-60 cursor-pointer"
          >
            Buat Session Room
          </button>

          <p class="mt-3 text-[11px] text-slate-500">
            Ingin ubah alamat Signaling Server atau URL Mic Client? Klik ikon gerigi di kanan atas.
          </p>
        </section>

        <!-- Active Room View (Visible Only After Room Is Created) -->
        <div id="active-room-view" class="hidden flex-1 flex-col gap-3.5">
          <!-- Section 1: Room & QR Code -->
          <section class="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-xs font-bold tracking-wider text-slate-300 uppercase">
                1. Room &amp; QR Code
              </h2>
              <button
                id="exit-room-top-btn"
                type="button"
                class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300 transition hover:bg-rose-500/20 cursor-pointer"
              >
                Keluar Room
              </button>
            </div>

            <p id="room-status-detail" class="mt-1 text-xs text-slate-400"></p>

            <div
              id="room-error-box"
              class="mt-2.5 hidden rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            >
              <p id="room-error-text"></p>
            </div>

            <div
              id="qr-mixed-warning"
              class="mt-2.5 hidden rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"
            >
              <p id="qr-mixed-warning-text"></p>
            </div>

            <!-- Live Room QR Block -->
            <div class="mt-3 flex flex-col items-center gap-3">
              <div class="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                <div>
                  <p class="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                    Kode Room
                  </p>
                  <p
                    id="room-code-text"
                    class="font-mono text-xl font-extrabold tracking-[0.22em] text-violet-300"
                  >
                    ------
                  </p>
                </div>
                <button
                  id="copy-code-btn"
                  type="button"
                  class="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-violet-500/60 hover:text-white cursor-pointer"
                >
                  Salin Kode
                </button>
              </div>

              <div class="rounded-2xl bg-white p-2.5 shadow-md shadow-black/40">
                <canvas id="qr-canvas" width="168" height="168" class="block h-[168px] w-[168px]"></canvas>
              </div>

              <div class="w-full space-y-1.5">
                <p
                  id="join-url-preview"
                  class="truncate rounded-lg border border-slate-800 bg-slate-950/70 px-2.5 py-1.5 font-mono text-[10px] text-slate-400"
                ></p>
                <button
                  id="copy-link-btn"
                  type="button"
                  class="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-500 active:scale-[0.99] cursor-pointer"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                  <span>Copy Mic Link</span>
                </button>
              </div>
            </div>
          </section>

          <!-- Section 2: YouTube Master -->
          <section class="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5">
            <h2 class="text-xs font-bold tracking-wider text-slate-300 uppercase">
              2. YouTube Master
            </h2>

            <div class="mt-2 flex items-center gap-2 rounded-xl border border-slate-800/90 bg-slate-950/60 px-2.5 py-2">
              <span id="yt-status-dot" class="h-2 w-2 shrink-0 rounded-full bg-slate-500"></span>
              <p id="yt-title" class="min-w-0 flex-1 truncate text-xs text-slate-300">
                Buka tab YouTube untuk kontrol musik
              </p>
            </div>

            <div class="mt-3">
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium text-slate-300">Volume Musik Latar</span>
                <div class="flex items-center gap-1.5">
                  <span
                    id="yt-ducked-badge"
                    class="hidden rounded-full border border-violet-500/50 bg-violet-500/20 px-2 py-0.5 text-[10px] font-semibold text-violet-300"
                  >
                    Ducked 30%
                  </span>
                  <span id="yt-volume-value" class="font-mono font-semibold text-slate-200">85%</span>
                </div>
              </div>
              <input
                id="yt-volume-slider"
                type="range"
                min="0"
                max="100"
                step="1"
                value="85"
                class="karo-slider mt-2 w-full"
              />
            </div>

            <label class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 cursor-pointer select-none">
              <div>
                <p class="text-xs font-semibold text-slate-200">Quick Ducking (30%)</p>
                <p class="text-[10px] text-slate-400">
                  Kecilkan musik YouTube otomatis saat vokal berbicara
                </p>
              </div>
              <input
                id="ducking-toggle"
                type="checkbox"
                class="h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-900 accent-violet-500"
              />
            </label>
          </section>

          <!-- Section 3: Active Mics -->
          <section class="flex-1 rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <h2 class="text-xs font-bold tracking-wider text-slate-300 uppercase">
                  3. Active Mics
                </h2>
                <span
                  id="mic-count-badge"
                  class="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-violet-300"
                >
                  0
                </span>
              </div>
              <button
                id="limiter-badge"
                type="button"
                title="Klik untuk menyetel preset & threshold Limiter HDMI TV"
                class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 transition hover:border-emerald-400/60 cursor-pointer"
              >
                Limiter ON
              </button>
            </div>

            <!-- Collapsible Vocal Limiter & HDMI Audio Tuning -->
            <div
              id="limiter-tuning-panel"
              class="mt-2.5 hidden rounded-xl border border-slate-800 bg-slate-950/75 p-2.5"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-semibold text-slate-200">Vocal Limiter &amp; HDMI Audio</span>
                <span
                  id="audio-latency-badge"
                  class="rounded-md border border-slate-700/80 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                >
                  Latency: --
                </span>
              </div>

              <div class="mt-2 grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  data-compressor-preset="tv_safe"
                  class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] font-semibold text-slate-300 transition hover:border-violet-500/60 cursor-pointer"
                >
                  TV Safe
                </button>
                <button
                  type="button"
                  data-compressor-preset="balanced"
                  class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] font-semibold text-slate-300 transition hover:border-violet-500/60 cursor-pointer"
                >
                  Balanced
                </button>
                <button
                  type="button"
                  data-compressor-preset="stage"
                  class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] font-semibold text-slate-300 transition hover:border-violet-500/60 cursor-pointer"
                >
                  Stage
                </button>
              </div>

              <div class="mt-2.5">
                <div class="flex items-center justify-between text-[11px]">
                  <span class="text-slate-400">Limiter Threshold</span>
                  <span id="limiter-threshold-value" class="font-mono font-semibold text-violet-300">
                    -18 dB · 8:1
                  </span>
                </div>
                <input
                  id="limiter-threshold-slider"
                  type="range"
                  min="${MIN_COMPRESSOR_THRESHOLD_DB}"
                  max="${MAX_COMPRESSOR_THRESHOLD_DB}"
                  step="1"
                  value="-18"
                  class="karo-slider mt-1.5 w-full"
                />
                <p class="mt-1 text-[10px] leading-snug text-slate-500">
                  Pilih <strong>TV Safe (-22 dB)</strong> untuk mencegah vokal pecah atau feedback di speaker TV HDMI.
                </p>
              </div>
            </div>

            <!-- Master Vocal Bus Slider -->
            <div class="mt-2.5 rounded-xl border border-slate-800/80 bg-slate-950/50 px-3 py-2">
              <div class="flex items-center justify-between text-[11px]">
                <span class="font-medium text-slate-400">Master Vocal Output</span>
                <span id="master-vocal-value" class="font-mono font-semibold text-slate-200">100%</span>
              </div>
              <input
                id="master-vocal-slider"
                type="range"
                min="0"
                max="150"
                step="1"
                value="100"
                class="karo-slider mt-1.5 w-full"
              />
            </div>

            <div
              id="mics-empty-state"
              class="mt-3 rounded-xl border border-dashed border-slate-800 px-3 py-6 text-center"
            >
              <p class="text-xs font-medium text-slate-400">Belum ada mikrofon terhubung</p>
              <p class="mt-1 text-[11px] text-slate-500">
                Scan QR Code di atas menggunakan kamera HP untuk bergabung.
              </p>
            </div>

            <div id="mics-list" class="mt-3 flex flex-col gap-2.5"></div>
          </section>

          <!-- Footer Exit Button -->
          <button
            id="exit-room-footer-btn"
            type="button"
            class="w-full rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20 cursor-pointer"
          >
            Keluar &amp; Tutup Session Room
          </button>
        </div>
      </main>
    `;

    // Bind elements
    this.statusPill = this.requireEl('#room-status-pill');
    this.statusDot = this.requireEl('#room-status-dot');
    this.statusLabel = this.requireEl('#room-status-label');
    this.settingsToggleBtn = this.requireEl('#settings-toggle-btn');
    this.settingsDrawer = this.requireEl('#settings-drawer');
    this.settingsForm = this.requireEl('#settings-form');
    this.signalingInput = this.requireEl('#signaling-url-input');
    this.clientUrlInput = this.requireEl('#client-url-input');
    this.includeWsCheckbox = this.requireEl('#include-ws-checkbox');
    this.settingsMixedWarningEl = this.requireEl('#settings-mixed-warning');
    this.settingsMixedWarningText = this.requireEl('#settings-mixed-warning-text');
    this.useTunnelWsBtn = this.requireEl('#use-tunnel-ws-btn');
    this.settingsResetBtn = this.requireEl('#settings-reset-btn');
    this.settingsErrorEl = this.requireEl('#settings-error');
    this.audioBanner = this.requireEl('#audio-suspended-banner');
    this.resumeAudioBtn = this.requireEl('#resume-audio-btn');

    this.lobbyView = this.requireEl('#lobby-view');
    this.lobbyStatusDetail = this.requireEl('#lobby-status-detail');
    this.lobbyErrorBox = this.requireEl('#lobby-error-box');
    this.lobbyErrorText = this.requireEl('#lobby-error-text');
    this.createRoomBtn = this.requireEl('#create-room-btn');
    this.activeRoomView = this.requireEl('#active-room-view');

    this.roomErrorBox = this.requireEl('#room-error-box');
    this.roomErrorText = this.requireEl('#room-error-text');
    this.qrMixedWarningBox = this.requireEl('#qr-mixed-warning');
    this.qrMixedWarningText = this.requireEl('#qr-mixed-warning-text');
    this.roomStatusDetail = this.requireEl('#room-status-detail');
    this.roomCodeText = this.requireEl('#room-code-text');
    this.copyCodeBtn = this.requireEl('#copy-code-btn');
    this.qrCanvas = this.requireEl('#qr-canvas');
    this.joinUrlPreview = this.requireEl('#join-url-preview');
    this.copyLinkBtn = this.requireEl('#copy-link-btn');
    this.exitRoomTopBtn = this.requireEl('#exit-room-top-btn');
    this.exitRoomFooterBtn = this.requireEl('#exit-room-footer-btn');

    this.ytStatusDot = this.requireEl('#yt-status-dot');
    this.ytTitleEl = this.requireEl('#yt-title');
    this.ytVolumeSlider = this.requireEl('#yt-volume-slider');
    this.ytVolumeValue = this.requireEl('#yt-volume-value');
    this.ytDuckedBadge = this.requireEl('#yt-ducked-badge');
    this.duckingToggle = this.requireEl('#ducking-toggle');

    this.micCountBadge = this.requireEl('#mic-count-badge');
    this.limiterBadge = this.requireEl('#limiter-badge');
    this.limiterPanel = this.requireEl('#limiter-tuning-panel');
    this.audioLatencyBadge = this.requireEl('#audio-latency-badge');
    this.presetButtons = new Map<BuiltInCompressorPresetId, HTMLButtonElement>([
      ['tv_safe', this.requireEl('[data-compressor-preset="tv_safe"]')],
      ['balanced', this.requireEl('[data-compressor-preset="balanced"]')],
      ['stage', this.requireEl('[data-compressor-preset="stage"]')],
    ]);
    this.limiterThresholdSlider = this.requireEl('#limiter-threshold-slider');
    this.limiterThresholdValue = this.requireEl('#limiter-threshold-value');
    this.masterVocalSlider = this.requireEl('#master-vocal-slider');
    this.masterVocalValue = this.requireEl('#master-vocal-value');
    this.micsEmptyState = this.requireEl('#mics-empty-state');
    this.micsListEl = this.requireEl('#mics-list');

    this.bindEvents();
    this.syncSettingsInputs(this.session.getState());
    this.unsubscribe = this.session.subscribe((state) => this.render(state));
    this.startMeterLoop();
  }

  public destroy(): void {
    this.unsubscribe();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.copyLinkTimer !== null) {
      clearTimeout(this.copyLinkTimer);
    }
    if (this.copyCodeTimer !== null) {
      clearTimeout(this.copyCodeTimer);
    }
  }

  private requireEl<T extends HTMLElement>(selector: string): T {
    const el = document.querySelector<T>(selector);
    if (!el) {
      throw new Error(`Missing required UI element: ${selector}`);
    }
    return el;
  }

  private bindEvents(): void {
    this.settingsToggleBtn.addEventListener('click', () => {
      const isHidden = this.settingsDrawer.classList.toggle('hidden');
      if (!isHidden) {
        this.syncSettingsInputs(this.session.getState());
        this.settingsErrorEl.classList.add('hidden');
      }
    });

    this.settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = this.session.updateSettings({
        signalingUrl: this.signalingInput.value,
        clientBaseUrl: this.clientUrlInput.value,
        includeWsInQr: this.includeWsCheckbox.checked,
      });
      if (!result.ok) {
        this.settingsErrorEl.textContent = result.error ?? 'Pengaturan tidak valid.';
        this.settingsErrorEl.classList.remove('hidden');
        return;
      }
      this.settingsErrorEl.classList.add('hidden');
      this.settingsDrawer.classList.add('hidden');
    });

    this.settingsResetBtn.addEventListener('click', () => {
      const defaults = getDefaultSettings();
      this.signalingInput.value = defaults.signalingUrl;
      this.clientUrlInput.value = defaults.clientBaseUrl;
      this.includeWsCheckbox.checked = defaults.includeWsInQr;
      this.settingsErrorEl.classList.add('hidden');
      this.updateSettingsMixedWarning();
    });

    const handleSettingsDraftChange = () => {
      this.updateSettingsMixedWarning();
    };
    this.signalingInput.addEventListener('input', handleSettingsDraftChange);
    this.clientUrlInput.addEventListener('input', handleSettingsDraftChange);
    this.includeWsCheckbox.addEventListener('change', handleSettingsDraftChange);

    this.useTunnelWsBtn.addEventListener('click', () => {
      const derived = deriveTunnelSignalingUrl(this.clientUrlInput.value);
      if (derived) {
        this.signalingInput.value = derived;
        this.updateSettingsMixedWarning();
      }
    });

    this.limiterBadge.addEventListener('click', () => {
      this.limiterPanel.classList.toggle('hidden');
    });

    for (const [presetId, button] of this.presetButtons.entries()) {
      button.addEventListener('click', () => {
        this.session.setCompressorPreset(presetId);
      });
    }

    this.limiterThresholdSlider.addEventListener('input', () => {
      const thresholdDb = Number(this.limiterThresholdSlider.value);
      this.session.setCompressorThreshold(thresholdDb);
    });

    this.resumeAudioBtn.addEventListener('click', () => {
      void this.session.resumeAudio();
    });

    this.createRoomBtn.addEventListener('click', () => {
      this.session.startRoom();
    });

    const handleExitRoom = () => {
      this.session.stopRoom();
    };
    this.exitRoomTopBtn.addEventListener('click', handleExitRoom);
    this.exitRoomFooterBtn.addEventListener('click', handleExitRoom);

    this.copyCodeBtn.addEventListener('click', () => {
      const roomId = this.session.getState().roomId;
      if (!roomId) {
        return;
      }
      void this.copyText(roomId).then((ok) => {
        if (!ok) {
          return;
        }
        this.copyCodeBtn.textContent = 'Tersalin!';
        if (this.copyCodeTimer !== null) {
          clearTimeout(this.copyCodeTimer);
        }
        this.copyCodeTimer = setTimeout(() => {
          this.copyCodeBtn.textContent = 'Salin Kode';
        }, 1800);
      });
    });

    this.copyLinkBtn.addEventListener('click', () => {
      const joinUrl = this.session.getState().joinUrl;
      if (!joinUrl) {
        return;
      }
      void this.copyText(joinUrl).then((ok) => {
        if (!ok) {
          return;
        }
        const label = this.copyLinkBtn.querySelector('span');
        if (label) {
          label.textContent = 'Link Tersalin!';
        }
        if (this.copyLinkTimer !== null) {
          clearTimeout(this.copyLinkTimer);
        }
        this.copyLinkTimer = setTimeout(() => {
          const span = this.copyLinkBtn.querySelector('span');
          if (span) {
            span.textContent = 'Copy Mic Link';
          }
        }, 1800);
      });
    });

    this.ytVolumeSlider.addEventListener('input', () => {
      const pct = Number(this.ytVolumeSlider.value);
      void this.session.setYouTubeVolume(pct / 100);
    });

    this.duckingToggle.addEventListener('change', () => {
      this.session.setDuckingEnabled(this.duckingToggle.checked);
    });

    this.masterVocalSlider.addEventListener('input', () => {
      const pct = Number(this.masterVocalSlider.value);
      this.session.setMasterVocalVolume(pct / 100);
    });
  }

  private syncSettingsInputs(state: OperatorState): void {
    this.signalingInput.value = state.settings.signalingUrl;
    this.clientUrlInput.value = state.settings.clientBaseUrl;
    this.includeWsCheckbox.checked = state.settings.includeWsInQr;
    this.updateSettingsMixedWarning();
  }

  private updateSettingsMixedWarning(): void {
    const warning = detectMixedContentQrWarning({
      signalingUrl: this.signalingInput.value,
      clientBaseUrl: this.clientUrlInput.value,
      includeWsInQr: this.includeWsCheckbox.checked,
    });
    if (!warning) {
      this.settingsMixedWarningEl.classList.add('hidden');
      return;
    }
    this.settingsMixedWarningText.textContent = warning;
    this.settingsMixedWarningEl.classList.remove('hidden');

    const derived = deriveTunnelSignalingUrl(this.clientUrlInput.value);
    const canOfferTunnelBtn = Boolean(derived && derived.startsWith('wss://'));
    this.useTunnelWsBtn.classList.toggle('hidden', !canOfferTunnelBtn);
    if (derived) {
      this.useTunnelWsBtn.textContent = `Pakai Proxy (${derived})`;
    }
  }

  private render(state: OperatorState): void {
    // 1. Header status pill
    const meta = ROOM_STATUS_META[state.roomStatus];
    this.statusPill.className = `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.pillClass}`;
    this.statusDot.className = `h-2 w-2 rounded-full ${meta.dotClass}`;
    this.statusLabel.textContent = meta.label;

    // Audio suspended warning
    const showAudioBanner = state.peers.length > 0 && state.audioContextState === 'suspended';
    this.audioBanner.classList.toggle('hidden', !showAudioBanner);

    // 2. Toggle Lobby View vs Active Room View
    const isLive = state.roomStatus === 'live' && Boolean(state.roomId && state.joinUrl);
    this.lobbyView.classList.toggle('hidden', isLive);
    this.lobbyView.classList.toggle('flex', !isLive);
    this.activeRoomView.classList.toggle('hidden', !isLive);
    this.activeRoomView.classList.toggle('flex', isLive);

    if (!isLive) {
      const isConnecting = state.roomStatus === 'connecting';
      this.lobbyStatusDetail.textContent = isConnecting
        ? state.statusDetail
        : 'Buat session room terlebih dahulu untuk menampilkan QR Code, kontrol musik YouTube Master, dan mixer Active Mics.';

      if (state.error) {
        this.lobbyErrorText.textContent = state.error;
        this.lobbyErrorBox.classList.remove('hidden');
      } else {
        this.lobbyErrorBox.classList.add('hidden');
      }

      this.createRoomBtn.disabled = isConnecting;
      this.createRoomBtn.textContent = isConnecting
        ? 'Membuat Session Room...'
        : state.roomStatus === 'error'
          ? 'Coba Buat Session Room Lagi'
          : 'Buat Session Room';

      this.lastRenderedQrUrl = null;
      this.reconcilePeerCards([]);
      return;
    }

    // 3. Room & QR section (Live)
    this.roomStatusDetail.textContent = state.statusDetail;
    if (state.error) {
      this.roomErrorText.textContent = state.error;
      this.roomErrorBox.classList.remove('hidden');
    } else {
      this.roomErrorBox.classList.add('hidden');
    }

    const qrWarning = detectMixedContentQrWarning(state.settings);
    if (qrWarning) {
      this.qrMixedWarningText.textContent = qrWarning;
      this.qrMixedWarningBox.classList.remove('hidden');
    } else {
      this.qrMixedWarningBox.classList.add('hidden');
    }

    if (state.roomId && state.joinUrl) {
      this.roomCodeText.textContent = state.roomId;
      this.joinUrlPreview.textContent = state.joinUrl;
      if (this.lastRenderedQrUrl !== state.joinUrl) {
        this.lastRenderedQrUrl = state.joinUrl;
        void QRCode.toCanvas(this.qrCanvas, state.joinUrl, {
          width: 168,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: {
            dark: '#0f172a',
            light: '#ffffff',
          },
        }).catch((err: unknown) => {
          console.error('[KaroSync Operator] Failed to render QR code:', err);
        });
      }
    }

    // 3. YouTube Master section
    this.ytStatusDot.className = state.youtube.connected
      ? 'h-2 w-2 shrink-0 rounded-full bg-emerald-400'
      : 'h-2 w-2 shrink-0 rounded-full bg-slate-500';
    this.ytTitleEl.textContent = state.youtube.title;

    const targetPct = Math.round(state.youtube.targetVolume * 100);
    if (document.activeElement !== this.ytVolumeSlider) {
      this.ytVolumeSlider.value = String(targetPct);
    }
    this.ytVolumeValue.textContent = `${targetPct}%`;
    this.ytDuckedBadge.classList.toggle('hidden', !state.youtube.isDucked);
    this.duckingToggle.checked = state.youtube.duckingEnabled;

    // 4. Active Mics section
    this.micCountBadge.textContent = String(state.peers.length);

    this.audioLatencyBadge.textContent =
      state.audioLatencyMs !== null ? `Latency: ~${state.audioLatencyMs} ms` : 'Latency: --';

    for (const [presetId, button] of this.presetButtons.entries()) {
      const active = state.compressorPreset === presetId;
      button.className = active
        ? 'rounded-lg border border-violet-500 bg-violet-600/25 px-2 py-1.5 text-[10px] font-bold text-violet-200 transition cursor-pointer'
        : 'rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] font-semibold text-slate-300 transition hover:border-violet-500/60 cursor-pointer';
    }

    const thresholdRounded = Math.round(state.compressor.threshold);
    if (document.activeElement !== this.limiterThresholdSlider) {
      this.limiterThresholdSlider.value = String(thresholdRounded);
    }
    this.limiterThresholdValue.textContent = `${thresholdRounded} dB · ${Math.round(state.compressor.ratio)}:1`;

    const masterPct = Math.round(state.masterVocalVolume * 100);
    if (document.activeElement !== this.masterVocalSlider) {
      this.masterVocalSlider.value = String(masterPct);
    }
    this.masterVocalValue.textContent = `${masterPct}%`;

    this.micsEmptyState.classList.toggle('hidden', state.peers.length > 0);
    this.reconcilePeerCards(state.peers);
  }

  private reconcilePeerCards(peers: PeerMicState[]): void {
    const activeIds = new Set(peers.map((p) => p.clientId));

    // Remove departed peer cards
    for (const [clientId, refs] of this.peerCards.entries()) {
      if (!activeIds.has(clientId)) {
        refs.card.remove();
        this.peerCards.delete(clientId);
      }
    }

    // Create or update active peer cards in order
    for (const peer of peers) {
      let refs = this.peerCards.get(peer.clientId);
      if (!refs) {
        refs = this.createPeerCard(peer);
        this.peerCards.set(peer.clientId, refs);
        this.micsListEl.appendChild(refs.card);
      }
      this.updatePeerCard(refs, peer);
    }
  }

  private createPeerCard(peer: PeerMicState): PeerCardRefs {
    const card = document.createElement('article');
    card.className =
      'rounded-xl border border-slate-800 bg-slate-950/75 p-3 transition hover:border-slate-700';

    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <h3 data-role="name" class="truncate text-xs font-bold text-white"></h3>
            <span data-role="status" class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold"></span>
          </div>
          <p data-role="route" class="mt-0.5 text-[10px] text-slate-400"></p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            data-role="mute"
            type="button"
            class="rounded-lg border px-2 py-1 text-[10px] font-semibold transition cursor-pointer"
          >
            Mute
          </button>
          <button
            data-role="kick"
            type="button"
            class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-300 transition hover:bg-rose-500/20 cursor-pointer"
          >
            Kick
          </button>
        </div>
      </div>

      <!-- VU Meter -->
      <div class="mt-2.5 flex items-center gap-2">
        <span class="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">VU</span>
        <div class="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
          <div
            data-role="vu-fill"
            class="h-full w-0 rounded-full bg-emerald-400 transition-[width] duration-75"
          ></div>
        </div>
        <span data-role="vu-peak" class="h-2 w-2 rounded-full bg-slate-700"></span>
      </div>

      <!-- Volume Slider -->
      <div class="mt-2.5 flex items-center gap-2.5">
        <span class="text-[10px] font-medium text-slate-400">Vol</span>
        <input
          data-role="volume-slider"
          type="range"
          min="0"
          max="150"
          step="1"
          value="100"
          class="karo-slider flex-1"
        />
        <span data-role="volume-label" class="w-9 text-right font-mono text-[11px] font-semibold text-slate-200">
          100%
        </span>
      </div>
    `;

    const nameEl = card.querySelector<HTMLElement>('[data-role="name"]')!;
    const statusPill = card.querySelector<HTMLElement>('[data-role="status"]')!;
    const routeEl = card.querySelector<HTMLElement>('[data-role="route"]')!;
    const vuFill = card.querySelector<HTMLElement>('[data-role="vu-fill"]')!;
    const vuPeakDot = card.querySelector<HTMLElement>('[data-role="vu-peak"]')!;
    const volumeSlider = card.querySelector<HTMLInputElement>('[data-role="volume-slider"]')!;
    const volumeLabel = card.querySelector<HTMLElement>('[data-role="volume-label"]')!;
    const muteBtn = card.querySelector<HTMLButtonElement>('[data-role="mute"]')!;
    const kickBtn = card.querySelector<HTMLButtonElement>('[data-role="kick"]')!;

    volumeSlider.addEventListener('input', () => {
      const pct = Number(volumeSlider.value);
      this.session.setPeerVolume(peer.clientId, pct / 100);
    });

    muteBtn.addEventListener('click', () => {
      this.session.togglePeerHostMute(peer.clientId);
    });

    kickBtn.addEventListener('click', () => {
      this.session.kickPeer(peer.clientId);
    });

    return {
      card,
      nameEl,
      statusPill,
      routeEl,
      vuFill,
      vuPeakDot,
      volumeSlider,
      volumeLabel,
      muteBtn,
      kickBtn,
    };
  }

  private updatePeerCard(refs: PeerCardRefs, peer: PeerMicState): void {
    refs.nameEl.textContent = peer.name;

    const badge = getPeerStatusBadge(peer);
    refs.statusPill.textContent = badge.label;
    refs.statusPill.className = `shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`;

    if (peer.routeInfo) {
      refs.routeEl.textContent =
        peer.routeInfo.rttMs !== null
          ? `${peer.routeInfo.label} · ${peer.routeInfo.rttMs} ms`
          : peer.routeInfo.label;
    } else {
      refs.routeEl.textContent =
        peer.connectionState === 'connected' ? 'WebRTC P2P' : 'Menyiapkan jalur audio...';
    }

    const pct = Math.round(peer.volume * 100);
    if (document.activeElement !== refs.volumeSlider) {
      refs.volumeSlider.value = String(pct);
    }
    refs.volumeLabel.textContent = formatPercent(peer.volume);

    if (peer.hostMuted) {
      refs.muteBtn.textContent = 'Unmute';
      refs.muteBtn.className =
        'rounded-lg border border-amber-500/60 bg-amber-500/20 px-2 py-1 text-[10px] font-semibold text-amber-200 transition hover:bg-amber-500/30 cursor-pointer';
    } else {
      refs.muteBtn.textContent = 'Mute';
      refs.muteBtn.className =
        'rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 transition hover:border-slate-500 hover:text-white cursor-pointer';
    }
  }

  private startMeterLoop(): void {
    const tick = () => {
      const snapshot = this.session.sampleMeters(Date.now());

      for (const [clientId, refs] of this.peerCards.entries()) {
        const metrics = snapshot.levels.get(clientId);
        const level = metrics?.normalized ?? 0;
        const pct = Math.round(level * 100);
        refs.vuFill.style.width = `${pct}%`;

        if (level > 0.85) {
          refs.vuFill.className = 'h-full rounded-full bg-rose-500 transition-[width] duration-75';
          refs.vuPeakDot.className = 'h-2 w-2 rounded-full bg-rose-500';
        } else if (level > 0.6) {
          refs.vuFill.className = 'h-full rounded-full bg-amber-400 transition-[width] duration-75';
          refs.vuPeakDot.className = 'h-2 w-2 rounded-full bg-amber-400';
        } else if (level > 0.04) {
          refs.vuFill.className = 'h-full rounded-full bg-emerald-400 transition-[width] duration-75';
          refs.vuPeakDot.className = 'h-2 w-2 rounded-full bg-emerald-400';
        } else {
          refs.vuFill.className = 'h-full rounded-full bg-emerald-400 transition-[width] duration-75';
          refs.vuPeakDot.className = 'h-2 w-2 rounded-full bg-slate-700';
        }
      }

      if (snapshot.compressorReductionDb < -1) {
        const db = Math.abs(snapshot.compressorReductionDb).toFixed(1);
        this.limiterBadge.textContent = `Limiter -${db} dB`;
        this.limiterBadge.className =
          'rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300 transition hover:border-amber-400/70 cursor-pointer';
      } else {
        this.limiterBadge.textContent = 'Limiter ON';
        this.limiterBadge.className =
          'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 transition hover:border-emerald-400/60 cursor-pointer';
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        return true;
      } catch {
        return false;
      }
    }
  }
}
