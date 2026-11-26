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
  onError: (code: ErrorCode | 'CONNECTION_ERROR' | 'TIMEOUT', message: string) => void;
  onClose: (info: { code: number; reason: string; expected: boolean }) => void;
}

export interface HostSignalingOptions {
  url: string;
  connectTimeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
  callbacks: HostSignalingCallbacks;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export class HostSignalingClient {
  private readonly options: HostSignalingOptions;
  private socket: WebSocketLike | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
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
          break;

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
    this.closeSocketSilently(1000, 'Operator closed room');
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
