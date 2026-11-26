import { MAX_CLIENT_NAME_LENGTH, ROOM_ID_LENGTH } from './protocol';

export interface VocalAudioTrackConstraints extends MediaTrackConstraints {
  latency?: ConstrainDouble;
}

export const VOCAL_AUDIO_CONSTRAINTS: VocalAudioTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  latency: 0.01,
};

export const VOCAL_AUDIO_FALLBACK_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 2,
};

const STORAGE_SINGER_NAME_KEY = 'karosync.mic.singerName';
const STORAGE_SIGNALING_URL_KEY = 'karosync.mic.signalingUrl';
const DEFAULT_SIGNALING_PORT = 8080;

export interface LaunchParams {
  roomId: string;
  fromQuery: boolean;
  querySignalingUrl: string | null;
}

export interface LocationLike {
  protocol: string;
  hostname: string;
}

export interface ResolveSignalingUrlOptions {
  queryWs?: string | null;
  overrideWs?: string | null;
  envWs?: string | null;
  location?: LocationLike;
}

export function normalizeRoomId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_ID_LENGTH);
}

export function validateRoomId(raw: string): string | null {
  const normalized = normalizeRoomId(raw);
  if (normalized.length === 0) {
    return 'Masukkan kode Room terlebih dahulu.';
  }
  if (normalized.length !== ROOM_ID_LENGTH) {
    return `Kode Room harus terdiri dari ${ROOM_ID_LENGTH} karakter.`;
  }
  return null;
}

export function validateClientName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return 'Masukkan Nama Penyanyi terlebih dahulu.';
  }
  if (trimmed.length > MAX_CLIENT_NAME_LENGTH) {
    return `Nama Penyanyi maksimal ${MAX_CLIENT_NAME_LENGTH} karakter.`;
  }
  return null;
}

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

export function parseLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);
  const rawRoom = params.get('room') ?? '';
  const roomId = normalizeRoomId(rawRoom);
  const rawWs = params.get('ws')?.trim() ?? '';
  const querySignalingUrl = isValidWebSocketUrl(rawWs) ? rawWs : null;

  return {
    roomId,
    fromQuery: roomId.length > 0,
    querySignalingUrl,
  };
}

export function resolveSignalingUrl(options: ResolveSignalingUrlOptions = {}): string {
  const candidates = [options.queryWs, options.overrideWs, options.envWs];
  for (const candidate of candidates) {
    if (candidate && isValidWebSocketUrl(candidate)) {
      return candidate.trim();
    }
  }

  const loc = options.location ?? { protocol: 'http:', hostname: 'localhost' };
  const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = loc.hostname || 'localhost';
  return `${wsProtocol}//${hostname}:${DEFAULT_SIGNALING_PORT}`;
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

export function loadSavedSingerName(): string {
  try {
    return window.localStorage.getItem(STORAGE_SINGER_NAME_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function saveSingerName(name: string): void {
  try {
    const trimmed = name.trim();
    if (trimmed) {
      window.localStorage.setItem(STORAGE_SINGER_NAME_KEY, trimmed);
    }
  } catch {
    // Ignore storage errors (e.g. Safari Private Browsing)
  }
}

export function loadSavedSignalingUrl(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_SIGNALING_URL_KEY)?.trim() ?? '';
    return isValidWebSocketUrl(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveSignalingUrl(url: string | null): void {
  try {
    if (url && isValidWebSocketUrl(url)) {
      window.localStorage.setItem(STORAGE_SIGNALING_URL_KEY, url.trim());
    } else {
      window.localStorage.removeItem(STORAGE_SIGNALING_URL_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}
