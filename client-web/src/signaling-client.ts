import {
  HOST_PEER_ID,
  WS_CLOSE_KICKED,
  WS_CLOSE_ROOM_CLOSED,
  parseServerMessage,
  type ClientToServerMessage,
  type ErrorCode,
  type IceCandidatePayload,
  type KickedMessage,
  type RelayedSignalMessage,
  type RoomClosedMessage,
  type RoomJoinedMessage,
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

export interface SignalingSignalPayload {
  sdp?: SessionDescriptionPayload;
  candidate?: IceCandidatePayload;
}

export interface SignalingClientCallbacks {
  onJoined: (msg: RoomJoinedMessage) => void;
  onSignal: (msg: RelayedSignalMessage) => void;
  onKicked: (msg: KickedMessage) => void;
  onRoomClosed: (msg: RoomClosedMessage) => void;
  onPingUpdate?: (pingMs: number) => void;
  onError: (code: ErrorCode | 'CONNECTION_ERROR' | 'TIMEOUT', message: string) => void;
  onClose: (info: { code: number; reason: string; expected: boolean }) => void;
}

export interface SignalingClientOptions {
  url: string;
  roomId: string;
  clientName: string;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
  callbacks: SignalingClientCallbacks;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 5_000;

export function formatSignalingError(code: ErrorCode, fallbackMessage: string): string {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return 'Room tidak ditemukan. Pastikan kode Room benar dan KaroSync Operator aktif.';
    case 'ROOM_FULL':
      return 'Room sudah penuh. Coba lagi saat ada mikrofon yang keluar.';
    case 'INVALID_PAYLOAD':
      return 'Data koneksi tidak valid. Periksa kode Room dan Nama Penyanyi.';
    case 'TARGET_NOT_FOUND':
      return 'Host room tidak lagi terjangkau.';
    case 'ALREADY_IN_ROOM':
      return 'Koneksi ini sudah terdaftar di dalam room.';
    default:
      return fallbackMessage;
  }
}

export class SignalingClient {
  private readonly options: SignalingClientOptions;
  private socket: WebSocketLike | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingSentAt: number | null = null;
  private closedManually = false;
  private terminalEventReceived = false;
  private joined = false;

  constructor(options: SignalingClientOptions) {
    this.options = options;
  }

  public connect(): void {
    this.closedManually = false;
    this.terminalEventReceived = false;
    this.joined = false;

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
        if (!this.joined && !this.closedManually && !this.terminalEventReceived) {
          this.terminalEventReceived = true;
          this.closeSocketSilently(1000, 'Connection timeout');
          this.options.callbacks.onError(
            'TIMEOUT',
            'Waktu koneksi ke Signaling Server habis. Pastikan server aktif dan alamat benar.',
          );
        }
      }, timeoutMs);
    }

    ws.onopen = () => {
      if (this.socket !== ws || this.closedManually) {
        return;
      }
      this.sendMessage({
        type: 'JOIN_ROOM',
        roomId: this.options.roomId,
        clientName: this.options.clientName,
      });
    };

    ws.onmessage = (event) => {
      if (this.socket !== ws || this.closedManually) {
        return;
      }
      if (typeof event.data !== 'string') {
        return;
      }

      const msg = parseServerMessage(event.data);
      if (!msg) {
        return;
      }

      switch (msg.type) {
        case 'ROOM_JOINED':
          this.joined = true;
          this.clearConnectTimer();
          this.options.callbacks.onJoined(msg);
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

        case 'SIGNAL':
          this.options.callbacks.onSignal(msg);
          break;

        case 'KICKED':
          this.terminalEventReceived = true;
          this.clearConnectTimer();
          this.options.callbacks.onKicked(msg);
          break;

        case 'ROOM_CLOSED':
          this.terminalEventReceived = true;
          this.clearConnectTimer();
          this.options.callbacks.onRoomClosed(msg);
          break;

        case 'ERROR':
          this.clearConnectTimer();
          this.options.callbacks.onError(msg.code, formatSignalingError(msg.code, msg.message));
          break;
      }
    };

    ws.onerror = () => {
      if (this.socket !== ws || this.closedManually || this.terminalEventReceived) {
        return;
      }
      this.clearConnectTimer();
      this.terminalEventReceived = true;
      this.options.callbacks.onError(
        'CONNECTION_ERROR',
        'Gagal terhubung ke Signaling Server. Periksa jaringan Wi-Fi dan alamat server.',
      );
    };

    ws.onclose = (event) => {
      if (this.socket !== ws) {
        return;
      }
      this.clearConnectTimer();
      this.stopPingLoop();
      this.socket = null;

      if (this.terminalEventReceived) {
        return;
      }

      if (event.code === WS_CLOSE_KICKED) {
        this.terminalEventReceived = true;
        this.options.callbacks.onKicked({
          type: 'KICKED',
          roomId: this.options.roomId,
          reason: event.reason || 'Removed by host',
        });
        return;
      }

      if (event.code === WS_CLOSE_ROOM_CLOSED) {
        this.terminalEventReceived = true;
        this.options.callbacks.onRoomClosed({
          type: 'ROOM_CLOSED',
          roomId: this.options.roomId,
          reason: event.reason || 'Host disconnected',
        });
        return;
      }

      this.options.callbacks.onClose({
        code: event.code,
        reason: event.reason,
        expected: this.closedManually,
      });
    };
  }

  public sendSignal(payload: SignalingSignalPayload): boolean {
    if (!payload.sdp && !payload.candidate) {
      return false;
    }

    return this.sendMessage({
      type: 'SIGNAL',
      targetId: HOST_PEER_ID,
      ...(payload.sdp !== undefined ? { sdp: payload.sdp } : {}),
      ...(payload.candidate !== undefined ? { candidate: payload.candidate } : {}),
    });
  }

  public disconnect(): void {
    this.closedManually = true;
    this.clearConnectTimer();
    this.stopPingLoop();
    this.closeSocketSilently(1000, 'Client disconnected');
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

  private sendMessage(message: ClientToServerMessage): boolean {
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
        // Ignore close errors during teardown
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
