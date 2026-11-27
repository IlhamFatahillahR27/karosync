import {
  COMPRESSOR_PRESETS,
  DEFAULT_ANTI_FEEDBACK_DSP,
  DEFAULT_COMPRESSOR_PRESET,
  MAX_COMPRESSOR_THRESHOLD_DB,
  MIN_COMPRESSOR_THRESHOLD_DB,
  normalizeAntiFeedbackDsp,
  type AntiFeedbackDspSettings,
  type BuiltInCompressorPresetId,
  type CompressorPresetId,
} from './audio-mixer';

export const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
export const DEFAULT_CLIENT_BASE_URL = 'http://localhost:5173';

export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 2,
};

export interface OperatorSettings {
  signalingUrl: string;
  clientBaseUrl: string;
  includeWsInQr: boolean;
}

export interface SavedCompressorConfig {
  preset: CompressorPresetId;
  thresholdDb: number;
}

const STORAGE_SETTINGS_KEY = 'karosync.operator.settings';
const STORAGE_DUCKING_KEY = 'karosync.operator.duckingEnabled';
const STORAGE_COMPRESSOR_KEY = 'karosync.operator.compressor';
const STORAGE_ANTI_FEEDBACK_KEY = 'karosync.operator.antiFeedbackDsp';

export function isValidWebSocketUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

export function isValidHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getEnvSignalingUrl(): string | null {
  const raw =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_SIGNALING_URL
      : undefined;
  if (typeof raw === 'string' && isValidWebSocketUrl(raw)) {
    return raw.trim();
  }
  return null;
}

export function getEnvClientBaseUrl(): string | null {
  const raw =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_CLIENT_URL
      : undefined;
  if (typeof raw === 'string' && isValidHttpUrl(raw)) {
    return raw.trim();
  }
  return null;
}

export function getDefaultSettings(): OperatorSettings {
  return {
    signalingUrl: getEnvSignalingUrl() ?? DEFAULT_SIGNALING_URL,
    clientBaseUrl: getEnvClientBaseUrl() ?? DEFAULT_CLIENT_BASE_URL,
    includeWsInQr: true,
  };
}

export interface BuildMicJoinUrlOptions {
  clientBaseUrl: string;
  roomId: string;
  signalingUrl?: string;
  includeWsInQr?: boolean;
}

export function buildMicJoinUrl(options: BuildMicJoinUrlOptions): string {
  const base = isValidHttpUrl(options.clientBaseUrl)
    ? options.clientBaseUrl.trim()
    : DEFAULT_CLIENT_BASE_URL;
  const url = new URL(base);
  url.searchParams.set('room', options.roomId.trim().toUpperCase());

  if (options.includeWsInQr && options.signalingUrl && isValidWebSocketUrl(options.signalingUrl)) {
    url.searchParams.set('ws', options.signalingUrl.trim());
  } else {
    url.searchParams.delete('ws');
  }

  return url.toString();
}

export function loadOperatorSettings(): OperatorSettings {
  const defaults = getDefaultSettings();
  try {
    const raw = window.localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<OperatorSettings>;
    return {
      signalingUrl:
        typeof parsed.signalingUrl === 'string' && isValidWebSocketUrl(parsed.signalingUrl)
          ? parsed.signalingUrl.trim()
          : defaults.signalingUrl,
      clientBaseUrl:
        typeof parsed.clientBaseUrl === 'string' && isValidHttpUrl(parsed.clientBaseUrl)
          ? parsed.clientBaseUrl.trim()
          : defaults.clientBaseUrl,
      includeWsInQr:
        typeof parsed.includeWsInQr === 'boolean' ? parsed.includeWsInQr : defaults.includeWsInQr,
    };
  } catch {
    return defaults;
  }
}

export function saveOperatorSettings(settings: OperatorSettings): void {
  try {
    window.localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

export function loadDuckingEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_DUCKING_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveDuckingEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_DUCKING_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage errors
  }
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]';
}

export function deriveTunnelSignalingUrl(clientBaseUrl: string): string | null {
  if (!isValidHttpUrl(clientBaseUrl)) {
    return null;
  }
  const parsed = new URL(clientBaseUrl.trim());
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${parsed.host}/ws`;
}

export function detectMixedContentQrWarning(settings: OperatorSettings): string | null {
  if (!settings.includeWsInQr) {
    return null;
  }
  if (!isValidHttpUrl(settings.clientBaseUrl) || !isValidWebSocketUrl(settings.signalingUrl)) {
    return null;
  }

  const clientUrl = new URL(settings.clientBaseUrl.trim());
  const sigUrl = new URL(settings.signalingUrl.trim());

  if (clientUrl.protocol === 'https:' && sigUrl.protocol === 'ws:') {
    return 'Halaman Mic HTTPS akan memblokir WebSocket ws:// (Mixed Content). Gunakan wss:// (mis. proxy /ws dari tunnel HTTPS atau server produksi).';
  }

  if (!isLocalHostname(clientUrl.hostname) && isLocalHostname(sigUrl.hostname)) {
    return 'HP tidak dapat menjangkau Signaling Server di localhost. Gunakan alamat wss:// tunnel (/ws) atau IP/domain server.';
  }

  return null;
}

function isBuiltInPreset(value: unknown): value is BuiltInCompressorPresetId {
  return value === 'tv_safe' || value === 'balanced' || value === 'stage';
}

export function getDefaultCompressorConfig(): SavedCompressorConfig {
  return {
    preset: DEFAULT_COMPRESSOR_PRESET,
    thresholdDb: COMPRESSOR_PRESETS[DEFAULT_COMPRESSOR_PRESET].threshold,
  };
}

export function loadCompressorConfig(): SavedCompressorConfig {
  const defaults = getDefaultCompressorConfig();
  try {
    const raw = window.localStorage.getItem(STORAGE_COMPRESSOR_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<SavedCompressorConfig>;
    if (isBuiltInPreset(parsed.preset)) {
      return {
        preset: parsed.preset,
        thresholdDb: COMPRESSOR_PRESETS[parsed.preset].threshold,
      };
    }
    if (
      parsed.preset === 'custom' &&
      typeof parsed.thresholdDb === 'number' &&
      Number.isFinite(parsed.thresholdDb)
    ) {
      const clamped = Math.min(
        MAX_COMPRESSOR_THRESHOLD_DB,
        Math.max(MIN_COMPRESSOR_THRESHOLD_DB, Math.round(parsed.thresholdDb)),
      );
      return {
        preset: 'custom',
        thresholdDb: clamped,
      };
    }
    return defaults;
  } catch {
    return defaults;
  }
}

export function saveCompressorConfig(config: SavedCompressorConfig): void {
  try {
    window.localStorage.setItem(STORAGE_COMPRESSOR_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage errors
  }
}

export function loadAntiFeedbackDsp(): AntiFeedbackDspSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_ANTI_FEEDBACK_KEY);
    if (!raw) {
      return { ...DEFAULT_ANTI_FEEDBACK_DSP };
    }
    const parsed = JSON.parse(raw) as Partial<AntiFeedbackDspSettings>;
    return normalizeAntiFeedbackDsp(parsed);
  } catch {
    return { ...DEFAULT_ANTI_FEEDBACK_DSP };
  }
}

export function saveAntiFeedbackDsp(settings: AntiFeedbackDspSettings): void {
  try {
    window.localStorage.setItem(STORAGE_ANTI_FEEDBACK_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}
