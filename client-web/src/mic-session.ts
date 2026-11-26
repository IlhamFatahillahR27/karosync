import { AudioCapture, formatMicrophoneError } from './audio-capture';
import {
  isValidWebSocketUrl,
  normalizeRoomId,
  validateClientName,
  validateRoomId,
} from './config';
import type { RelayedSignalMessage } from './protocol';
import { SignalingClient, type SignalingClientOptions } from './signaling-client';
import { WakeLockController, type WakeLockState } from './wake-lock';
import {
  WebRtcSender,
  type RouteInfo,
  type WebRtcSenderOptions,
} from './webrtc-sender';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'live' | 'muted_by_host';

export interface MicSessionState {
  status: ConnectionStatus;
  statusDetail: string;
  roomId: string;
  clientId: string | null;
  clientName: string;
  signalingUrl: string;
  selfMuted: boolean;
  hostMuted: boolean;
  wakeLockState: WakeLockState;
  routeInfo: RouteInfo | null;
  serverPingMs: number | null;
  error: string | null;
}

export interface ConnectRequest {
  roomId: string;
  clientName: string;
  signalingUrl: string;
}

export interface AudioCaptureLike {
  start(callbacks?: { onTrackEnded?: () => void }): Promise<MediaStream>;
  setMuted(muted: boolean): boolean;
  toggleMute(): boolean;
  isMuted(): boolean;
  getStream(): MediaStream | null;
  sampleAudio(): ReturnType<AudioCapture['sampleAudio']>;
  stop(): void;
}

export interface SignalingClientLike {
  connect(): void;
  sendSignal(payload: Parameters<SignalingClient['sendSignal']>[0]): boolean;
  disconnect(): void;
}

export interface WebRtcSenderLike {
  startOffer(): Promise<void>;
  handleIncomingSignal(msg: RelayedSignalMessage): Promise<void>;
  sendSelfMute(muted: boolean): void;
  close(): void;
}

export interface WakeLockControllerLike {
  getState(): WakeLockState;
  acquire(): Promise<WakeLockState>;
  release(): Promise<void>;
}

export interface MicSessionDependencies {
  audioCapture?: AudioCaptureLike;
  createSignalingClient?: (options: SignalingClientOptions) => SignalingClientLike;
  createWebRtcSender?: (options: WebRtcSenderOptions) => WebRtcSenderLike;
  createWakeLockController?: (onStateChange: (state: WakeLockState) => void) => WakeLockControllerLike;
}

export type SessionListener = (state: MicSessionState) => void;

export class MicSession {
  private readonly audioCapture: AudioCaptureLike;
  private readonly createSignalingClient: (options: SignalingClientOptions) => SignalingClientLike;
  private readonly createWebRtcSender: (options: WebRtcSenderOptions) => WebRtcSenderLike;
  private readonly wakeLock: WakeLockControllerLike;

  private signaling: SignalingClientLike | null = null;
  private webrtc: WebRtcSenderLike | null = null;
  private listeners = new Set<SessionListener>();
  private sessionSeq = 0;
  private state: MicSessionState;

  constructor(
    initial: { roomId: string; clientName: string; signalingUrl: string },
    deps: MicSessionDependencies = {},
  ) {
    this.audioCapture = deps.audioCapture ?? new AudioCapture();
    this.createSignalingClient =
      deps.createSignalingClient ?? ((options) => new SignalingClient(options));
    this.createWebRtcSender =
      deps.createWebRtcSender ?? ((options) => new WebRtcSender(options));
    this.wakeLock =
      deps.createWakeLockController?.((wakeLockState) => {
        this.updateState({ wakeLockState });
      }) ??
      new WakeLockController({
        onStateChange: (wakeLockState) => {
          this.updateState({ wakeLockState });
        },
      });

    this.state = {
      status: 'disconnected',
      statusDetail: 'Siap terhubung ke panggung KaroSync.',
      roomId: normalizeRoomId(initial.roomId),
      clientId: null,
      clientName: initial.clientName.trim(),
      signalingUrl: initial.signalingUrl,
      selfMuted: false,
      hostMuted: false,
      wakeLockState: this.wakeLock.getState(),
      routeInfo: null,
      serverPingMs: null,
      error: null,
    };
  }

  public getState(): MicSessionState {
    return this.state;
  }

  public getAudioCapture(): AudioCaptureLike {
    return this.audioCapture;
  }

  public subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async connect(request: ConnectRequest): Promise<void> {
    const roomId = normalizeRoomId(request.roomId);
    const clientName = request.clientName.trim();
    const signalingUrl = request.signalingUrl.trim();

    const roomError = validateRoomId(roomId);
    if (roomError) {
      this.updateState({ roomId, clientName, signalingUrl, error: roomError });
      return;
    }

    const nameError = validateClientName(clientName);
    if (nameError) {
      this.updateState({ roomId, clientName, signalingUrl, error: nameError });
      return;
    }

    if (!isValidWebSocketUrl(signalingUrl)) {
      this.updateState({
        roomId,
        clientName,
        signalingUrl,
        error: 'URL Signaling Server harus diawali ws:// atau wss://.',
      });
      return;
    }

    this.teardownResources();
    const currentSeq = ++this.sessionSeq;

    this.updateState({
      status: 'connecting',
      statusDetail: 'Meminta izin mikrofon...',
      roomId,
      clientId: null,
      clientName,
      signalingUrl,
      selfMuted: false,
      hostMuted: false,
      routeInfo: null,
      serverPingMs: null,
      error: null,
    });

    let stream: MediaStream;
    try {
      stream = await this.audioCapture.start({
        onTrackEnded: () => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.failAndDisconnect(
            'Mikrofon terputus oleh sistem atau perangkat audio berubah.',
            'Mikrofon terputus.',
          );
        },
      });
    } catch (error) {
      if (currentSeq !== this.sessionSeq) {
        return;
      }
      const message =
        error instanceof Error ? error.message : formatMicrophoneError(error);
      this.failAndDisconnect(message, 'Gagal mengaktifkan mikrofon.');
      return;
    }

    if (currentSeq !== this.sessionSeq) {
      this.audioCapture.stop();
      return;
    }

    const wakeLockState = await this.wakeLock.acquire();
    if (currentSeq !== this.sessionSeq) {
      await this.wakeLock.release();
      return;
    }

    this.updateState({
      wakeLockState,
      statusDetail: `Menghubungi Room ${roomId}...`,
    });

    const signaling = this.createSignalingClient({
      url: signalingUrl,
      roomId,
      clientName,
      callbacks: {
        onJoined: (msg) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.updateState({
            roomId: msg.roomId,
            clientId: msg.clientId,
            clientName: msg.clientName,
            statusDetail: 'Menyiapkan jalur audio WebRTC P2P...',
          });

          const webrtc = this.createWebRtcSender({
            stream,
            initialSelfMuted: this.state.selfMuted,
            callbacks: {
              sendSignal: (payload) => {
                if (currentSeq !== this.sessionSeq) {
                  return;
                }
                this.signaling?.sendSignal(payload);
              },
              onConnectionStateChange: (connState) => {
                if (currentSeq !== this.sessionSeq) {
                  return;
                }
                this.handleWebRtcStateChange(connState);
              },
              onHostMuteChange: (muted) => {
                if (currentSeq !== this.sessionSeq) {
                  return;
                }
                this.handleHostMuteChange(muted);
              },
              onRouteInfoChange: (routeInfo) => {
                if (currentSeq !== this.sessionSeq) {
                  return;
                }
                this.updateState({ routeInfo });
              },
            },
          });

          this.webrtc = webrtc;

          void webrtc.startOffer().catch((err: unknown) => {
            if (currentSeq !== this.sessionSeq) {
              return;
            }
            const message =
              err instanceof Error ? err.message : 'Gagal membuat SDP Offer WebRTC.';
            this.failAndDisconnect(message, 'Negosiasi WebRTC gagal.');
          });
        },

        onSignal: (msg) => {
          if (currentSeq !== this.sessionSeq || !this.webrtc) {
            return;
          }
          void this.webrtc.handleIncomingSignal(msg).catch((err: unknown) => {
            if (currentSeq !== this.sessionSeq) {
              return;
            }
            const message =
              err instanceof Error ? err.message : 'Gagal memproses sinyal WebRTC.';
            this.failAndDisconnect(message, 'Sinyal WebRTC bermasalah.');
          });
        },

        onKicked: (msg) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.failAndDisconnect(
            `Anda dikeluarkan oleh Operator: ${msg.reason}`,
            'Dikeluarkan oleh Operator.',
          );
        },

        onRoomClosed: (msg) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.failAndDisconnect(
            `Sesi karaoke ditutup oleh Operator (${msg.reason}).`,
            'Room ditutup oleh Operator.',
          );
        },

        onPingUpdate: (serverPingMs) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.updateState({ serverPingMs });
        },

        onError: (_code, message) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.failAndDisconnect(message, 'Koneksi gagal.');
        },

        onClose: ({ expected }) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          if (expected) {
            return;
          }
          this.failAndDisconnect(
            'Koneksi ke Signaling Server terputus. Coba hubungkan ulang.',
            'Terputus dari server.',
          );
        },
      },
    });

    this.signaling = signaling;
    signaling.connect();
  }

  public toggleSelfMute(): void {
    if (this.state.status === 'disconnected') {
      return;
    }
    const nextMuted = this.audioCapture.toggleMute();
    this.webrtc?.sendSelfMute(nextMuted);
    this.updateState({ selfMuted: nextMuted });
  }

  public disconnect(detail = 'Mikrofon diputus.'): void {
    this.sessionSeq += 1;
    this.teardownResources();
    this.updateState({
      status: 'disconnected',
      statusDetail: detail,
      clientId: null,
      selfMuted: false,
      hostMuted: false,
      routeInfo: null,
      serverPingMs: null,
      error: null,
    });
  }

  private handleWebRtcStateChange(connState: RTCPeerConnectionState): void {
    switch (connState) {
      case 'connecting':
      case 'new':
        this.updateState({
          status: 'connecting',
          statusDetail: 'Menghubungkan audio P2P ke Operator...',
        });
        break;

      case 'connected':
        this.updateState({
          status: this.state.hostMuted ? 'muted_by_host' : 'live',
          statusDetail: this.state.hostMuted
            ? 'Mikrofon dibisukan sementara oleh Operator.'
            : 'Suara Anda tersambung langsung ke panggung.',
          error: null,
        });
        break;

      case 'disconnected':
        this.updateState({
          status: 'connecting',
          statusDetail: 'Koneksi P2P terganggu, mencoba menyambung ulang...',
        });
        break;

      case 'failed':
        this.failAndDisconnect(
          'Koneksi audio WebRTC P2P gagal tersambung. Pastikan HP dan komputer berada di jaringan yang stabil.',
          'Koneksi audio P2P gagal.',
        );
        break;

      case 'closed':
        this.disconnect('Sesi audio berakhir.');
        break;
    }
  }

  private handleHostMuteChange(muted: boolean): void {
    if (this.state.status === 'disconnected') {
      return;
    }

    const isLiveOrHostMuted =
      this.state.status === 'live' || this.state.status === 'muted_by_host';

    this.updateState({
      hostMuted: muted,
      ...(isLiveOrHostMuted
        ? {
            status: muted ? 'muted_by_host' : 'live',
            statusDetail: muted
              ? 'Mikrofon dibisukan sementara oleh Operator.'
              : 'Suara Anda tersambung langsung ke panggung.',
          }
        : {}),
    });
  }

  private failAndDisconnect(errorMessage: string, statusDetail: string): void {
    this.sessionSeq += 1;
    this.teardownResources();
    this.updateState({
      status: 'disconnected',
      statusDetail,
      clientId: null,
      selfMuted: false,
      hostMuted: false,
      routeInfo: null,
      serverPingMs: null,
      error: errorMessage,
    });
  }

  private teardownResources(): void {
    if (this.webrtc) {
      this.webrtc.close();
      this.webrtc = null;
    }

    if (this.signaling) {
      this.signaling.disconnect();
      this.signaling = null;
    }

    this.audioCapture.stop();
    void this.wakeLock.release();
  }

  private updateState(partial: Partial<MicSessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
