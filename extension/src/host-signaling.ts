import {
  parseHostServerMessage,
  type ClientJoinedMessage,
  type ClientLeftMessage,
  type ErrorCode,
  type HostToServerMessage,
  type IceCandidatePayload,
  type RelayedSignalMessage,
  type RoomCreatedMessage,
  type SessionDescriptionPayload,
} from './protocol';

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const WS_READY_STATE_CONNECTING = 0;
export const WS_READY_STATE_OPEN = 1;

export interface HostSignalPayload {
  sdp?: SessionDescriptionPayload;
  candidate?: IceCandidatePayload;
}

export interface HostSignalingCallbacks {
  onRoomCreated: (msg: RoomCreatedMessage) => void;
  onClientJoined: (msg: ClientJoinedMessage) => void;
  onClientLeft: (msg: ClientLeftMessage) => void;
  onSignal: (msg: RelayedSignalMessage) => void;
  onPingUpdate?: (pingMs: number) => void;
  onError: (code: ErrorCode | 'CONNECTION_ERROR' | 'TIMEOUT', message: string) => void;
  onClose: (info: { code: number; reason: string; expected: boolean }) => void;
}

export interface HostSignalingOptions {
  url: string;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
  callbacks: HostSignalingCallbacks;
}

export interface ConnectionTestOptions {
  timeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface ConnectionTestResult {
  ok: boolean;
  pingMs: number | null;
  error: string | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_TEST_TIMEOUT_MS = 5_000;

export function testSignalingConnection(
  url: string,
  options: ConnectionTestOptions = {},
): Promise<ConnectionTestResult> {
  const trimmed = url.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return Promise.resolve({
      ok: false,
      pingMs: null,
      error: 'Format URL Signaling Server tidak valid.',
    });
  }

  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    return Promise.resolve({
      ok: false,
      pingMs: null,
      error: 'URL Signaling Server harus diawali ws:// atau wss://.',
    });
  }

  const factory =
    options.webSocketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  return new Promise<ConnectionTestResult>((resolve) => {
    let settled = false;
    let ws: WebSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pingSentAt = 0;

    const finish = (result: ConnectionTestResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (
          ws.readyState === WS_READY_STATE_CONNECTING ||
          ws.readyState === WS_READY_STATE_OPEN
        ) {
          try {
            ws.close(1000, 'Connection test complete');
          } catch {
            // Ignore close errors
          }
        }
        ws = null;
      }
      resolve(result);
    };

    try {
      ws = factory(trimmed);
    } catch {
      finish({
        ok: false,
        pingMs: null,
        error: `Gagal membuka koneksi ke ${trimmed}.`,
      });
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({
          ok: false,
          pingMs: null,
          error: 'Timeout — Signaling Server tidak merespons. Pastikan server aktif dan URL benar.',
        });
      }, timeoutMs);
    }

    ws.onopen = () => {
      if (settled || !ws) {
        return;
      }
      pingSentAt = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'PING', ts: pingSentAt }));
      } catch {
        finish({
          ok: false,
          pingMs: null,
          error: 'Koneksi terbuka, tetapi gagal mengirim paket PING.',
        });
      }
    };

    ws.onmessage = (event) => {
      if (settled || typeof event.data !== 'string') {
        return;
      }
      const msg = parseHostServerMessage(event.data);
      if (msg?.type === 'PONG') {
        const sentAt = msg.ts ?? pingSentAt;
        const pingMs = Math.max(0, Math.round(Date.now() - sentAt));
        finish({ ok: true, pingMs, error: null });
      }
    };

    ws.onerror = () => {
      finish({
        ok: false,
        pingMs: null,
        error: 'Gagal terhubung ke Signaling Server. Periksa alamat WebSocket atau firewall.',
      });
    };

    ws.onclose = () => {
      finish({
        ok: false,
        pingMs: null,
        error: 'Koneksi ditutup oleh server sebelum tes selesai.',
      });
    };
  });
}

export class HostSignalingClient {
  private readonly options: HostSignalingOptions;
  private socket: WebSocketLike | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingSentAt: number | null = null;
  private closedManually = false;
  private terminalError = false;
  private roomCreated = false;

  constructor(options: HostSignalingOptions) {
    this.options = options;
  }

  public connect(): void {
    this.closedManually = false;
    this.terminalError = false;
    this.roomCreated = false;

    const factory =
      this.options.webSocketFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

    let ws: WebSocketLike;
    try {
      ws = factory(this.options.url);
    } catch {
      this.options.callbacks.onError(
        'CONNECTION_ERROR',
        `URL Signaling Server tidak valid: ${this.options.url}`,
      );
      return;
    }

    this.socket = ws;

    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      this.connectTimer = setTimeout(() => {
        if (!this.roomCreated && !this.closedManually && !this.terminalError) {
          this.terminalError = true;
          this.closeSocketSilently(1000, 'Connection timeout');
          this.options.callbacks.onError(
            'TIMEOUT',
            'Waktu koneksi ke Signaling Server habis. Pastikan server berjalan dan URL benar.',
          );
        }
      }, timeoutMs);
    }

    ws.onopen = () => {
      if (this.socket !== ws || this.closedManually) {
        return;
      }
      this.sendMessage({ type: 'CREATE_ROOM' });
    };

    ws.onmessage = (event) => {
      if (this.socket !== ws || this.closedManually) {
        return;
      }
      if (typeof event.data !== 'string') {
        return;
      }

      const msg = parseHostServerMessage(event.data);
      if (!msg) {
        return;
      }

      switch (msg.type) {
        case 'ROOM_CREATED':
          this.roomCreated = true;
          this.clearConnectTimer();
          this.options.callbacks.onRoomCreated(msg);
          this.startPingLoop();
          break;

        case 'PONG': {
          const sentAt = msg.ts ?? this.lastPingSentAt;
          if (sentAt !== null && Number.isFinite(sentAt)) {
            const rtt = Math.max(0, Math.round(Date.now() - sentAt));
            this.options.callbacks.onPingUpdate?.(rtt);
          }
          break;
        }

        case 'CLIENT_JOINED':
          this.options.callbacks.onClientJoined(msg);
          break;

        case 'CLIENT_LEFT':
          this.options.callbacks.onClientLeft(msg);
          break;

        case 'SIGNAL':
          this.options.callbacks.onSignal(msg);
          break;

        case 'ERROR':
          this.clearConnectTimer();
          this.options.callbacks.onError(msg.code, msg.message);
          break;
      }
    };

    ws.onerror = () => {
      if (this.socket !== ws || this.closedManually || this.terminalError) {
        return;
      }
      this.clearConnectTimer();
      this.terminalError = true;
      this.options.callbacks.onError(
        'CONNECTION_ERROR',
        'Gagal terhubung ke Signaling Server. Pastikan server aktif dan alamat WebSocket benar.',
      );
    };

    ws.onclose = (event) => {
      if (this.socket !== ws) {
        return;
      }
      this.clearConnectTimer();
      this.stopPingLoop();
      this.socket = null;

      if (this.terminalError) {
        return;
      }

      this.options.callbacks.onClose({
        code: event.code,
        reason: event.reason,
        expected: this.closedManually,
      });
    };
  }

  public sendSignal(targetClientId: string, payload: HostSignalPayload): boolean {
    if (!targetClientId || (!payload.sdp && !payload.candidate)) {
      return false;
    }

    return this.sendMessage({
      type: 'SIGNAL',
      targetId: targetClientId,
      ...(payload.sdp !== undefined ? { sdp: payload.sdp } : {}),
      ...(payload.candidate !== undefined ? { candidate: payload.candidate } : {}),
    });
  }

  public kickClient(clientId: string, reason = 'Removed by operator'): boolean {
    if (!clientId) {
      return false;
    }
    return this.sendMessage({
      type: 'KICK_CLIENT',
      clientId,
      reason,
    });
  }

  public disconnect(): void {
    this.closedManually = true;
    this.clearConnectTimer();
    this.stopPingLoop();
    this.closeSocketSilently(1000, 'Operator closed room');
  }

  public sendPing(): boolean {
    const now = Date.now();
    this.lastPingSentAt = now;
    return this.sendMessage({ type: 'PING', ts: now });
  }

  private startPingLoop(): void {
    if (!this.options.callbacks.onPingUpdate) {
      return;
    }
    const intervalMs = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    if (intervalMs <= 0) {
      return;
    }
    this.stopPingLoop();
    this.sendPing();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, intervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.lastPingSentAt = null;
  }

  private sendMessage(message: HostToServerMessage): boolean {
    if (!this.socket || this.socket.readyState !== WS_READY_STATE_OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private closeSocketSilently(code: number, reason: string): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) {
      return;
    }
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (
      ws.readyState === WS_READY_STATE_CONNECTING ||
      ws.readyState === WS_READY_STATE_OPEN
    ) {
      try {
        ws.close(code, reason);
      } catch {
        // Ignore teardown close errors
      }
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
