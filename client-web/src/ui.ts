import {
  normalizeRoomId,
  saveAudioMode,
  saveSingerName,
  type AudioCaptureMode,
} from './config';
import type { ConnectionStatus, MicSession, MicSessionState } from './mic-session';
import { MAX_CLIENT_NAME_LENGTH, ROOM_ID_LENGTH } from './protocol';
import { AudioVisualizer, type VisualizerMode } from './visualizer';

export interface KaroSyncMicUIOptions {
  root: HTMLElement;
  session: MicSession;
  initialRoomFromQuery: boolean;
  defaultSignalingUrl: string;
}

const STATUS_META: Record<
  ConnectionStatus,
  { label: string; pillClass: string; dotClass: string }
> = {
  disconnected: {
    label: 'Disconnected',
    pillClass: 'border-slate-700/80 bg-slate-800/80 text-slate-300',
    dotClass: 'bg-slate-400',
  },
  connecting: {
    label: 'Connecting',
    pillClass: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
    dotClass: 'bg-sky-400 animate-pulse',
  },
  live: {
    label: 'Live on Air',
    pillClass: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    dotClass: 'bg-emerald-400 live-pulse',
  },
  muted_by_host: {
    label: 'Muted by Host',
    pillClass: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
    dotClass: 'bg-amber-400',
  },
};

const MIC_ICON_SVG = `
<svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
  <line x1="12" x2="12" y1="19" y2="22" />
</svg>
`;

const MIC_OFF_ICON_SVG = `
<svg class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <line x1="2" x2="22" y1="2" y2="22" />
  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
  <path d="M5 10v2a7 7 0 0 0 12 5" />
  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
  <line x1="12" x2="12" y1="19" y2="22" />
</svg>
`;

const MIC_LIVE_ICON_SVG = `
<svg class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
  <line x1="12" x2="12" y1="19" y2="22" />
</svg>
`;

export class KaroSyncMicUI {
  private readonly session: MicSession;
  private readonly defaultSignalingUrl: string;
  private readonly visualizer: AudioVisualizer;
  private readonly unsubscribe: () => void;

  // Header & status elements
  private readonly statusPill: HTMLElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly statusDetailEl: HTMLElement;
  private readonly httpsWarningEl: HTMLElement;

  // Join panel elements
  private readonly joinSection: HTMLElement;
  private readonly joinForm: HTMLFormElement;
  private readonly roomQrBadge: HTMLElement;
  private readonly roomInput: HTMLInputElement;
  private readonly singerNameInput: HTMLInputElement;
  private readonly audioModeAntiBtn: HTMLButtonElement;
  private readonly audioModeRawBtn: HTMLButtonElement;
  private readonly audioModeHintEl: HTMLElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly errorBox: HTMLElement;
  private readonly errorText: HTMLElement;
  private selectedAudioMode: AudioCaptureMode;

  // Live stage elements
  private readonly stageSection: HTMLElement;
  private readonly stageRoomEl: HTMLElement;
  private readonly stageNameEl: HTMLElement;
  private readonly visualizerModeBadge: HTMLElement;
  private readonly levelBarFill: HTMLElement;
  private readonly levelPercentEl: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly muteBtnIcon: HTMLElement;
  private readonly muteBtnLabel: HTMLElement;
  private readonly muteBtnSub: HTMLElement;
  private readonly hostMuteBanner: HTMLElement;
  private readonly wakeLockBadge: HTMLElement;
  private readonly routeBadge: HTMLElement;
  private readonly disconnectBtn: HTMLButtonElement;
  private readonly footerNoteEl: HTMLElement;

  constructor(options: KaroSyncMicUIOptions) {
    this.session = options.session;
    this.defaultSignalingUrl = options.defaultSignalingUrl;

    const initial = this.session.getState();
    this.selectedAudioMode = initial.audioMode;

    options.root.innerHTML = `
      <main class="safe-area-shell mx-auto flex min-h-dvh w-full max-w-md flex-col justify-between gap-5 px-4 py-5">
        <header class="flex items-center justify-between gap-3">
          <div>
            <p class="text-[11px] font-bold tracking-[0.22em] text-emerald-400 uppercase">KaroSync Mic</p>
            <h1 class="text-lg font-bold tracking-tight text-white">Wireless Stage Mic</h1>
          </div>
          <div
            data-el="status-pill"
            class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors"
            role="status"
            aria-live="polite"
          >
            <span data-el="status-dot" class="h-2 w-2 rounded-full"></span>
            <span data-el="status-text">Disconnected</span>
          </div>
        </header>

        <div
          data-el="https-warning"
          class="hidden rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200"
        >
          <p class="font-semibold text-amber-300">Koneksi Non-HTTPS Terdeteksi</p>
          <p class="mt-0.5 text-amber-200/90">
            Browser Android/iOS memerlukan HTTPS (atau <code class="font-mono">localhost</code>) agar mikrofon dan Wake Lock diizinkan.
          </p>
        </div>

        <section
          data-el="join-section"
          class="flex flex-1 flex-col justify-center"
        >
          <div class="rounded-3xl border border-slate-800/90 bg-slate-900/85 p-5 shadow-2xl shadow-black/40 backdrop-blur">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-base font-semibold text-white">Masuk ke Panggung</h2>
              <span
                data-el="room-qr-badge"
                class="hidden rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300"
              >
                QR Terdeteksi
              </span>
            </div>
            <p data-el="status-detail-join" class="mt-1 text-xs text-slate-400">
              Siap terhubung ke panggung KaroSync.
            </p>

            <div
              data-el="error-box"
              class="mt-4 hidden rounded-2xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-3 text-xs leading-relaxed text-rose-200"
              role="alert"
            >
              <span data-el="error-text"></span>
            </div>

            <form data-el="join-form" class="mt-5 space-y-4" novalidate>
              <div>
                <label for="room-input" class="block text-xs font-medium text-slate-300">
                  Kode Room (${ROOM_ID_LENGTH} karakter)
                </label>
                <input
                  id="room-input"
                  data-el="room-input"
                  type="text"
                  inputmode="text"
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck="false"
                  maxlength="${ROOM_ID_LENGTH}"
                  placeholder="Contoh: K7M2PX"
                  class="mt-1.5 w-full rounded-2xl border border-slate-700/90 bg-slate-950/90 px-4 py-3 font-mono text-lg font-bold tracking-[0.28em] text-white uppercase placeholder:font-sans placeholder:text-sm placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-500 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/25 focus:outline-none"
                />
              </div>

              <div>
                <label for="singer-name-input" class="block text-xs font-medium text-slate-300">
                  Nama Penyanyi
                </label>
                <input
                  id="singer-name-input"
                  data-el="singer-name-input"
                  type="text"
                  autocomplete="nickname"
                  maxlength="${MAX_CLIENT_NAME_LENGTH}"
                  placeholder="Masukkan nama Anda"
                  class="mt-1.5 w-full rounded-2xl border border-slate-700/90 bg-slate-950/90 px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/25 focus:outline-none"
                />
              </div>

              <div>
                <span class="block text-xs font-medium text-slate-300">Mode Audio Mikrofon</span>
                <div class="mt-1.5 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-el="mode-raw-vocal"
                    class="rounded-2xl border px-3 py-2.5 text-left transition cursor-pointer"
                  >
                    <p class="text-xs font-bold">Low-Latency</p>
                    <p class="mt-0.5 text-[10px] opacity-80">Super Cepat (Rekomendasi)</p>
                  </button>
                  <button
                    type="button"
                    data-el="mode-anti-feedback"
                    class="rounded-2xl border px-3 py-2.5 text-left transition cursor-pointer"
                  >
                    <p class="text-xs font-bold">Anti-Dengung</p>
                    <p class="mt-0.5 text-[10px] opacity-80">AEC (+delay ±100ms)</p>
                  </button>
                </div>
                <p data-el="audio-mode-hint" class="mt-1.5 text-[11px] leading-snug text-slate-400"></p>
              </div>

              <button
                type="submit"
                data-el="connect-btn"
                class="mt-2 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-emerald-500 px-5 py-4 text-base font-bold text-slate-950 shadow-lg shadow-emerald-500/25 transition active:scale-[0.98] hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                ${MIC_ICON_SVG}
                <span>Connect Mic</span>
              </button>
            </form>
          </div>
        </section>

        <section
          data-el="stage-section"
          class="hidden flex-1 flex-col justify-between gap-5"
        >
          <div class="rounded-3xl border border-slate-800/90 bg-slate-900/85 p-5 shadow-2xl shadow-black/40">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Penyanyi</p>
                <p data-el="stage-name" class="truncate text-xl font-bold text-white">-</p>
              </div>
              <div class="rounded-xl border border-slate-700/80 bg-slate-950/80 px-3 py-1.5 text-right">
                <p class="text-[10px] font-medium tracking-wider text-slate-400 uppercase">Room</p>
                <p data-el="stage-room" class="font-mono text-sm font-bold tracking-widest text-emerald-300">------</p>
              </div>
            </div>

            <p data-el="status-detail-stage" class="mt-2 text-xs text-slate-400"></p>

            <div
              data-el="host-mute-banner"
              class="mt-3 hidden rounded-2xl border border-amber-500/40 bg-amber-500/15 px-3.5 py-2.5 text-xs font-medium text-amber-200"
            >
              Mikrofon sedang dibisukan oleh Operator. Tunggu Operator mengaktifkan kembali.
            </div>

            <div class="mt-4 rounded-2xl border border-slate-800 bg-slate-950/90 p-3.5">
              <div class="mb-2 flex items-center justify-between text-[11px]">
                <span class="font-medium text-slate-400">Input Vokal Lokal</span>
                <span data-el="visualizer-mode-badge" class="font-semibold text-emerald-400">Mic Aktif</span>
              </div>
              <canvas
                data-el="visualizer-canvas"
                class="block h-24 w-full rounded-xl"
                aria-label="Audio level visualizer"
              ></canvas>
              <div class="mt-2.5 flex items-center gap-2.5">
                <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                  <div
                    data-el="level-bar-fill"
                    class="h-full w-0 rounded-full bg-emerald-400 transition-[width] duration-75"
                  ></div>
                </div>
                <span data-el="level-percent" class="w-9 text-right font-mono text-[11px] text-slate-400">0%</span>
              </div>
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
              <span
                data-el="wake-lock-badge"
                class="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-800/80 px-2.5 py-1 font-medium text-slate-300"
              >
                Screen Awake
              </span>
              <span
                data-el="route-badge"
                class="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-800/80 px-2.5 py-1 font-medium text-slate-300"
              >
                Menghubungkan P2P...
              </span>
            </div>
          </div>

          <div class="flex flex-col items-center gap-4">
            <button
              type="button"
              data-el="mute-btn"
              class="flex w-full items-center justify-center gap-3.5 rounded-3xl border px-6 py-5 text-left shadow-xl transition active:scale-[0.98]"
            >
              <span data-el="mute-btn-icon" class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl"></span>
              <span class="flex flex-col">
                <span data-el="mute-btn-label" class="text-lg font-bold leading-tight">Mute Mic</span>
                <span data-el="mute-btn-sub" class="text-xs opacity-80">Ketuk untuk membisukan sementara</span>
              </span>
            </button>

            <button
              type="button"
              data-el="disconnect-btn"
              class="w-full rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3 text-sm font-semibold text-slate-300 transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-200 active:scale-[0.99]"
            >
              Disconnect &amp; Keluar Room
            </button>
          </div>
        </section>

        <footer data-el="footer-note" class="text-center text-[11px] text-slate-500">
          Mode Anti-Dengung • Redam pantulan speaker ruangan
        </footer>
      </main>
    `;

    this.statusPill = this.requireEl(options.root, '[data-el="status-pill"]');
    this.statusDot = this.requireEl(options.root, '[data-el="status-dot"]');
    this.statusText = this.requireEl(options.root, '[data-el="status-text"]');
    this.statusDetailEl = this.requireEl(options.root, '[data-el="status-detail-stage"]');
    this.httpsWarningEl = this.requireEl(options.root, '[data-el="https-warning"]');

    this.joinSection = this.requireEl(options.root, '[data-el="join-section"]');
    this.joinForm = this.requireEl(options.root, '[data-el="join-form"]') as HTMLFormElement;
    this.roomQrBadge = this.requireEl(options.root, '[data-el="room-qr-badge"]');
    this.roomInput = this.requireEl(options.root, '[data-el="room-input"]') as HTMLInputElement;
    this.singerNameInput = this.requireEl(
      options.root,
      '[data-el="singer-name-input"]',
    ) as HTMLInputElement;
    this.audioModeAntiBtn = this.requireEl(
      options.root,
      '[data-el="mode-anti-feedback"]',
    ) as HTMLButtonElement;
    this.audioModeRawBtn = this.requireEl(
      options.root,
      '[data-el="mode-raw-vocal"]',
    ) as HTMLButtonElement;
    this.audioModeHintEl = this.requireEl(options.root, '[data-el="audio-mode-hint"]');
    this.connectBtn = this.requireEl(
      options.root,
      '[data-el="connect-btn"]',
    ) as HTMLButtonElement;
    this.errorBox = this.requireEl(options.root, '[data-el="error-box"]');
    this.errorText = this.requireEl(options.root, '[data-el="error-text"]');

    this.stageSection = this.requireEl(options.root, '[data-el="stage-section"]');
    this.stageRoomEl = this.requireEl(options.root, '[data-el="stage-room"]');
    this.stageNameEl = this.requireEl(options.root, '[data-el="stage-name"]');
    this.visualizerModeBadge = this.requireEl(options.root, '[data-el="visualizer-mode-badge"]');
    this.levelBarFill = this.requireEl(options.root, '[data-el="level-bar-fill"]');
    this.levelPercentEl = this.requireEl(options.root, '[data-el="level-percent"]');
    this.muteBtn = this.requireEl(options.root, '[data-el="mute-btn"]') as HTMLButtonElement;
    this.muteBtnIcon = this.requireEl(options.root, '[data-el="mute-btn-icon"]');
    this.muteBtnLabel = this.requireEl(options.root, '[data-el="mute-btn-label"]');
    this.muteBtnSub = this.requireEl(options.root, '[data-el="mute-btn-sub"]');
    this.hostMuteBanner = this.requireEl(options.root, '[data-el="host-mute-banner"]');
    this.wakeLockBadge = this.requireEl(options.root, '[data-el="wake-lock-badge"]');
    this.routeBadge = this.requireEl(options.root, '[data-el="route-badge"]');
    this.disconnectBtn = this.requireEl(
      options.root,
      '[data-el="disconnect-btn"]',
    ) as HTMLButtonElement;
    this.footerNoteEl = this.requireEl(options.root, '[data-el="footer-note"]');

    const canvas = this.requireEl(
      options.root,
      '[data-el="visualizer-canvas"]',
    ) as HTMLCanvasElement;

    this.visualizer = new AudioVisualizer({
      canvas,
      audioCapture: this.session.getAudioCapture(),
      onLevelUpdate: (levelPercent, clipping) => {
        this.levelBarFill.style.width = `${levelPercent}%`;
        this.levelBarFill.className = `h-full rounded-full transition-[width] duration-75 ${
          clipping ? 'bg-rose-400' : levelPercent > 65 ? 'bg-emerald-400' : 'bg-cyan-400'
        }`;
        this.levelPercentEl.textContent = `${levelPercent}%`;
      },
    });

    // Hydrate initial inputs
    this.roomInput.value = initial.roomId;
    this.singerNameInput.value = initial.clientName;
    this.renderAudioModeSelector();
    if (options.initialRoomFromQuery) {
      this.roomQrBadge.classList.remove('hidden');
    }

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      this.httpsWarningEl.classList.remove('hidden');
    }

    this.bindEvents();
    this.unsubscribe = this.session.subscribe((state) => {
      this.render(state);
    });
  }

  public destroy(): void {
    this.unsubscribe();
    this.visualizer.destroy();
  }

  private bindEvents(): void {
    this.roomInput.addEventListener('input', () => {
      const normalized = normalizeRoomId(this.roomInput.value);
      if (this.roomInput.value !== normalized) {
        this.roomInput.value = normalized;
      }
    });

    this.audioModeAntiBtn.addEventListener('click', () => {
      this.selectedAudioMode = 'anti_feedback';
      saveAudioMode('anti_feedback');
      this.renderAudioModeSelector();
    });

    this.audioModeRawBtn.addEventListener('click', () => {
      this.selectedAudioMode = 'raw_vocal';
      saveAudioMode('raw_vocal');
      this.renderAudioModeSelector();
    });

    this.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const roomId = normalizeRoomId(this.roomInput.value);
      const clientName = this.singerNameInput.value.trim();

      this.roomInput.value = roomId;
      saveSingerName(clientName);
      saveAudioMode(this.selectedAudioMode);

      void this.session.connect({
        roomId,
        clientName,
        signalingUrl: this.defaultSignalingUrl,
        audioMode: this.selectedAudioMode,
      });
    });

    this.muteBtn.addEventListener('click', () => {
      this.session.toggleSelfMute();
    });

    this.disconnectBtn.addEventListener('click', () => {
      this.session.disconnect();
    });
  }

  private renderAudioModeSelector(): void {
    const isAntiFeedback = this.selectedAudioMode === 'anti_feedback';
    const activeCls =
      'rounded-2xl border border-emerald-400/70 bg-emerald-500/15 px-3 py-2.5 text-left text-emerald-100 transition cursor-pointer';
    const inactiveCls =
      'rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2.5 text-left text-slate-400 transition hover:border-slate-700 hover:text-slate-200 cursor-pointer';

    this.audioModeAntiBtn.className = isAntiFeedback ? activeCls : inactiveCls;
    this.audioModeRawBtn.className = isAntiFeedback ? inactiveCls : activeCls;
    this.audioModeAntiBtn.setAttribute('aria-pressed', String(isAntiFeedback));
    this.audioModeRawBtn.setAttribute('aria-pressed', String(!isAntiFeedback));

    this.audioModeHintEl.textContent = isAntiFeedback
      ? 'Mengaktifkan Echo Cancellation di HP. Redam gema keras, tetapi menambah delay ±100 ms.'
      : 'Latensi tercepat (~15 ms). Anti-dengung ditangani Noise Gate & High-Pass Filter di Operator (0 ms delay).';
  }

  private render(state: MicSessionState): void {
    const activeMode = state.status === 'disconnected' ? this.selectedAudioMode : state.audioMode;
    this.footerNoteEl.textContent =
      activeMode === 'anti_feedback'
        ? 'Mode Anti-Dengung (AEC) • Redam gema keras (+delay)'
        : 'Mode Low-Latency • Dekatkan HP 3–5 cm ke mulut';
    const meta = STATUS_META[state.status];
    this.statusPill.className = `inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${meta.pillClass}`;
    this.statusDot.className = `h-2 w-2 rounded-full ${meta.dotClass}`;
    this.statusText.textContent = meta.label;

    const isDisconnected = state.status === 'disconnected';
    this.joinSection.classList.toggle('hidden', !isDisconnected);
    this.stageSection.classList.toggle('hidden', isDisconnected);
    this.stageSection.classList.toggle('flex', !isDisconnected);

    if (state.error) {
      this.errorBox.classList.remove('hidden');
      this.errorText.textContent = state.error;
    } else {
      this.errorBox.classList.add('hidden');
      this.errorText.textContent = '';
    }

    this.connectBtn.disabled = !isDisconnected;

    if (isDisconnected) {
      this.visualizer.setMode('idle');
      return;
    }

    this.stageRoomEl.textContent = state.roomId || '------';
    this.stageNameEl.textContent = state.clientName || '-';
    this.statusDetailEl.textContent = state.statusDetail;
    this.hostMuteBanner.classList.toggle('hidden', !state.hostMuted);

    // Update visualizer mode
    let vizMode: VisualizerMode = 'active';
    if (state.selfMuted) {
      vizMode = 'self_muted';
      this.visualizerModeBadge.textContent = 'Self-Muted';
      this.visualizerModeBadge.className = 'font-semibold text-rose-400';
    } else if (state.hostMuted) {
      vizMode = 'host_muted';
      this.visualizerModeBadge.textContent = 'Muted by Host';
      this.visualizerModeBadge.className = 'font-semibold text-amber-400';
    } else if (state.status === 'connecting') {
      vizMode = 'active';
      this.visualizerModeBadge.textContent = 'Mic Ready • Connecting';
      this.visualizerModeBadge.className = 'font-semibold text-sky-400';
    } else {
      vizMode = 'active';
      this.visualizerModeBadge.textContent = 'Mic Aktif';
      this.visualizerModeBadge.className = 'font-semibold text-emerald-400';
    }
    this.visualizer.setMode(vizMode);

    // Update Self-Mute button appearance
    if (state.selfMuted) {
      this.muteBtn.className =
        'flex w-full items-center justify-center gap-3.5 rounded-3xl border border-rose-500/60 bg-rose-500/20 px-6 py-5 text-left text-rose-100 shadow-xl shadow-rose-950/40 transition active:scale-[0.98]';
      this.muteBtnIcon.className =
        'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-rose-500 text-slate-950';
      this.muteBtnIcon.innerHTML = MIC_OFF_ICON_SVG;
      this.muteBtnLabel.textContent = 'Unmute Mic';
      this.muteBtnSub.textContent = 'Mikrofon lokal dibisukan — ketuk untuk menyalakan';
      this.muteBtn.setAttribute('aria-pressed', 'true');
    } else {
      this.muteBtn.className =
        'flex w-full items-center justify-center gap-3.5 rounded-3xl border border-emerald-500/40 bg-emerald-500/15 px-6 py-5 text-left text-emerald-50 shadow-xl shadow-emerald-950/30 transition active:scale-[0.98]';
      this.muteBtnIcon.className =
        'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500 text-slate-950';
      this.muteBtnIcon.innerHTML = MIC_LIVE_ICON_SVG;
      this.muteBtnLabel.textContent = 'Mute Mic';
      this.muteBtnSub.textContent = 'Mikrofon menyala — ketuk untuk bisukan lokal';
      this.muteBtn.setAttribute('aria-pressed', 'false');
    }

    // Wake Lock status badge
    if (state.wakeLockState === 'active') {
      this.wakeLockBadge.textContent = 'Wake Lock: Aktif';
      this.wakeLockBadge.className =
        'inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-300';
    } else if (state.wakeLockState === 'unsupported') {
      this.wakeLockBadge.textContent = 'Wake Lock: Tidak Didukung';
      this.wakeLockBadge.className =
        'inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-800/80 px-2.5 py-1 font-medium text-slate-400';
    } else {
      this.wakeLockBadge.textContent = 'Wake Lock: Nonaktif';
      this.wakeLockBadge.className =
        'inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 font-medium text-amber-300';
    }

    // WebRTC route badge
    if (state.routeInfo) {
      this.routeBadge.textContent = state.routeInfo.label;
      this.routeBadge.className =
        state.routeInfo.candidateType === 'host'
          ? 'inline-flex items-center gap-1.5 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 font-medium text-cyan-300'
          : 'inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-800/80 px-2.5 py-1 font-medium text-slate-300';
    } else if (state.status === 'live' || state.status === 'muted_by_host') {
      this.routeBadge.textContent = 'WebRTC P2P Terhubung';
      this.routeBadge.className =
        'inline-flex items-center gap-1.5 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 font-medium text-cyan-300';
    } else {
      this.routeBadge.textContent = 'Menghubungkan P2P...';
      this.routeBadge.className =
        'inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-800/80 px-2.5 py-1 font-medium text-slate-400';
    }
  }

  private requireEl(root: HTMLElement, selector: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) {
      throw new Error(`Missing required UI element: ${selector}`);
    }
    return el;
  }
}
