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

const STORAGE_SETTINGS_KEY = 'karosync.operator.settings';
const STORAGE_DUCKING_KEY = 'karosync.operator.duckingEnabled';

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
