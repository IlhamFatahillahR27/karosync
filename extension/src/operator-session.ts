import { AudioMixer, type MixerSampleSnapshot } from './audio-mixer';
import {
  buildMicJoinUrl,
  isValidHttpUrl,
  isValidWebSocketUrl,
  loadDuckingEnabled,
  loadOperatorSettings,
  saveDuckingEnabled,
  saveOperatorSettings,
  type OperatorSettings,
} from './config';
import { QuickDuckingController } from './ducking';
import { HostSignalingClient, type HostSignalingOptions } from './host-signaling';
import type { RelayedSignalMessage, YouTubeActionResponse, YouTubeStatusResponse } from './protocol';
import {
  WebRtcReceiverManager,
  type RouteInfo,
  type WebRtcReceiverManagerOptions,
} from './webrtc-receiver';
import { YouTubeController } from './youtube-controller';

export type RoomStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface PeerMicState {
  clientId: string;
  name: string;
  connectionState: RTCPeerConnectionState;
  volume: number;
  hostMuted: boolean;
  selfMuted: boolean;
  routeInfo: RouteInfo | null;
}

export interface YouTubePanelState {
  connected: boolean;
  title: string;
  targetVolume: number;
  effectiveVolume: number;
  muted: boolean;
  paused: boolean;
  duckingEnabled: boolean;
  isDucked: boolean;
}

export interface OperatorState {
  roomStatus: RoomStatus;
  statusDetail: string;
  roomId: string | null;
  joinUrl: string | null;
  error: string | null;
  audioContextState: AudioContextState;
  settings: OperatorSettings;
  masterVocalVolume: number;
  youtube: YouTubePanelState;
  peers: PeerMicState[];
}

export interface HostSignalingLike {
  connect(): void;
  sendSignal(
    targetClientId: string,
    payload: Parameters<HostSignalingClient['sendSignal']>[1],
  ): boolean;
  kickClient(clientId: string, reason?: string): boolean;
  disconnect(): void;
}

export interface WebRtcReceiverLike {
  ensurePeer(clientId: string): void;
  handleIncomingSignal(msg: RelayedSignalMessage): Promise<void>;
  setHostMute(clientId: string, muted: boolean): void;
  removePeer(clientId: string): void;
  closeAll(): void;
}

export interface AudioMixerLike {
  getContextState(): AudioContextState;
  ensureRunning(): Promise<AudioContextState>;
  attachStream(clientId: string, stream: MediaStream): void;
  setPeerVolume(clientId: string, volume: number): void;
  setPeerMuted(clientId: string, muted: boolean): void;
  setMasterVolume(volume: number): void;
  sampleLevels(): MixerSampleSnapshot;
  removePeer(clientId: string): void;
  dispose(): Promise<void>;
}

export interface YouTubeControllerLike {
  getStatus(): Promise<YouTubeStatusResponse | null>;
  setVolume(volume: number, muted?: boolean): Promise<YouTubeActionResponse | null>;
}

export interface OperatorSessionDependencies {
  initialSettings?: OperatorSettings;
  initialDuckingEnabled?: boolean;
  youtubePollIntervalMs?: number;
  createSignalingClient?: (options: HostSignalingOptions) => HostSignalingLike;
  createWebRtcManager?: (options: WebRtcReceiverManagerOptions) => WebRtcReceiverLike;
  audioMixer?: AudioMixerLike;
  youtubeController?: YouTubeControllerLike;
  duckingController?: QuickDuckingController;
}

export type OperatorStateListener = (state: OperatorState) => void;

const DEFAULT_YT_POLL_INTERVAL_MS = 2500;

export class OperatorSession {
  private readonly createSignalingClient: (options: HostSignalingOptions) => HostSignalingLike;
  private readonly createWebRtcManager: (options: WebRtcReceiverManagerOptions) => WebRtcReceiverLike;
  private readonly audioMixer: AudioMixerLike;
  private readonly youtube: YouTubeControllerLike;
  private readonly ducking: QuickDuckingController;
  private readonly youtubePollIntervalMs: number;

  private signaling: HostSignalingLike | null = null;
  private webrtc: WebRtcReceiverLike | null = null;
  private ytPollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionSeq = 0;
  private hasOperatorSetYtVolume = false;
  private disposed = false;

  private readonly listeners = new Set<OperatorStateListener>();
  private state: OperatorState;

  constructor(deps: OperatorSessionDependencies = {}) {
    const settings = deps.initialSettings ?? loadOperatorSettings();
    const duckingEnabled = deps.initialDuckingEnabled ?? loadDuckingEnabled();

    this.createSignalingClient =
      deps.createSignalingClient ?? ((options) => new HostSignalingClient(options));
    this.createWebRtcManager =
      deps.createWebRtcManager ?? ((options) => new WebRtcReceiverManager(options));
    this.audioMixer =
      deps.audioMixer ??
      new AudioMixer({
        onStateChange: (audioContextState) => {
          this.updateState({ audioContextState });
        },
      });
    this.youtube = deps.youtubeController ?? new YouTubeController();
    this.ducking =
      deps.duckingController ??
      new QuickDuckingController({
        initialEnabled: duckingEnabled,
        initialTargetVolume: 0.85,
      });
    this.youtubePollIntervalMs = deps.youtubePollIntervalMs ?? DEFAULT_YT_POLL_INTERVAL_MS;

    this.state = {
      roomStatus: 'idle',
      statusDetail: 'Siap membuat Room KaroSync.',
      roomId: null,
      joinUrl: null,
      error: null,
      audioContextState: this.audioMixer.getContextState(),
      settings,
      masterVocalVolume: 1,
      youtube: {
        connected: false,
        title: 'Buka tab YouTube untuk kontrol musik',
        targetVolume: this.ducking.getTargetVolume(),
        effectiveVolume: this.ducking.getEffectiveVolume(),
        muted: false,
        paused: true,
        duckingEnabled,
        isDucked: false,
      },
      peers: [],
    };
  }

  public getState(): OperatorState {
    return this.state;
  }

  public subscribe(listener: OperatorStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public startYouTubePolling(): void {
    this.stopYouTubePolling();
    void this.refreshYouTubeStatus();
    if (this.youtubePollIntervalMs > 0) {
      this.ytPollTimer = setInterval(() => {
        void this.refreshYouTubeStatus();
      }, this.youtubePollIntervalMs);
    }
  }

  public stopYouTubePolling(): void {
    if (this.ytPollTimer !== null) {
      clearInterval(this.ytPollTimer);
      this.ytPollTimer = null;
    }
  }

  public startRoom(): void {
    if (this.disposed) {
      return;
    }

    const { signalingUrl } = this.state.settings;
    if (!isValidWebSocketUrl(signalingUrl)) {
      this.updateState({
        roomStatus: 'error',
        statusDetail: 'URL Signaling Server tidak valid.',
        error: 'URL Signaling Server harus diawali ws:// atau wss://.',
      });
      return;
    }

    this.teardownRoomResources();
    const currentSeq = ++this.sessionSeq;

    void this.audioMixer.ensureRunning().then((audioContextState) => {
      if (!this.disposed) {
        this.updateState({ audioContextState });
      }
    });

    this.updateState({
      roomStatus: 'connecting',
      statusDetail: `Menghubungi ${signalingUrl}...`,
      roomId: null,
      joinUrl: null,
      error: null,
      peers: [],
    });

    const webrtc = this.createWebRtcManager({
      callbacks: {
        sendSignal: (targetClientId, payload) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.signaling?.sendSignal(targetClientId, payload);
        },
        onStream: (clientId, stream) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.audioMixer.attachStream(clientId, stream);
          this.updateState({
            audioContextState: this.audioMixer.getContextState(),
          });
        },
        onConnectionStateChange: (clientId, connectionState) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.patchPeer(clientId, { connectionState });
        },
        onSelfMuteChange: (clientId, selfMuted) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.patchPeer(clientId, { selfMuted });
        },
        onRouteInfoChange: (clientId, routeInfo) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.patchPeer(clientId, { routeInfo });
        },
      },
    });
    this.webrtc = webrtc;

    const signaling = this.createSignalingClient({
      url: signalingUrl,
      callbacks: {
        onRoomCreated: (msg) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          const joinUrl = buildMicJoinUrl({
            clientBaseUrl: this.state.settings.clientBaseUrl,
            roomId: msg.roomId,
            signalingUrl: this.state.settings.signalingUrl,
            includeWsInQr: this.state.settings.includeWsInQr,
          });
          this.updateState({
            roomStatus: 'live',
            statusDetail: 'Room aktif — scan QR Code dari HP untuk mulai bernyanyi.',
            roomId: msg.roomId,
            joinUrl,
            error: null,
          });
          this.startYouTubePolling();
        },

        onClientJoined: (msg) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.webrtc?.ensurePeer(msg.clientId);
          this.audioMixer.setPeerVolume(msg.clientId, 1);
          this.audioMixer.setPeerMuted(msg.clientId, false);

          const existing = this.state.peers.some((p) => p.clientId === msg.clientId);
          if (!existing) {
            const nextPeer: PeerMicState = {
              clientId: msg.clientId,
              name: msg.clientName,
              connectionState: 'connecting',
              volume: 1,
              hostMuted: false,
              selfMuted: false,
              routeInfo: null,
            };
            this.updateState({
              peers: [...this.state.peers, nextPeer],
            });
          }
        },

        onClientLeft: (msg) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          this.removePeerLocally(msg.clientId);
        },

        onSignal: (msg) => {
          if (currentSeq !== this.sessionSeq || !this.webrtc) {
            return;
          }
          void this.webrtc.handleIncomingSignal(msg).catch(() => {
            // Non-fatal per-peer WebRTC signal error
          });
        },

        onError: (_code, message) => {
          if (currentSeq !== this.sessionSeq) {
            return;
          }
          if (this.state.roomStatus !== 'live') {
            this.teardownRoomResources();
            this.updateState({
              roomStatus: 'error',
              statusDetail: 'Gagal membuat room.',
              roomId: null,
              joinUrl: null,
              error: message,
              peers: [],
            });
          } else {
            this.updateState({ error: message });
          }
        },

        onClose: ({ expected }) => {
          if (currentSeq !== this.sessionSeq || expected) {
            return;
          }
          this.teardownRoomResources();
          this.updateState({
            roomStatus: 'error',
            statusDetail: 'Koneksi ke Signaling Server terputus.',
            roomId: null,
            joinUrl: null,
            error: 'Signaling Server terputus. Klik Buat Room Ulang untuk menyambung kembali.',
            peers: [],
          });
        },
      },
    });

    this.signaling = signaling;
    signaling.connect();
  }

  public stopRoom(): void {
    this.sessionSeq += 1;
    this.stopYouTubePolling();
    this.restoreDuckingIfActive();
    this.teardownRoomResources();
    this.hasOperatorSetYtVolume = false;
    this.updateState({
      roomStatus: 'idle',
      statusDetail: 'Siap membuat Session Room baru.',
      roomId: null,
      joinUrl: null,
      error: null,
      peers: [],
    });
  }

  public updateSettings(next: OperatorSettings): { ok: boolean; error?: string } {
    const signalingUrl = next.signalingUrl.trim();
    const clientBaseUrl = next.clientBaseUrl.trim();

    if (!isValidWebSocketUrl(signalingUrl)) {
      return { ok: false, error: 'Signaling URL harus diawali ws:// atau wss://.' };
    }
    if (!isValidHttpUrl(clientBaseUrl)) {
      return { ok: false, error: 'Mic Client URL harus diawali http:// atau https://.' };
    }

    const prevSignalingUrl = this.state.settings.signalingUrl;
    const cleaned: OperatorSettings = {
      signalingUrl,
      clientBaseUrl,
      includeWsInQr: next.includeWsInQr,
    };

    saveOperatorSettings(cleaned);

    const joinUrl = this.state.roomId
      ? buildMicJoinUrl({
          clientBaseUrl: cleaned.clientBaseUrl,
          roomId: this.state.roomId,
          signalingUrl: cleaned.signalingUrl,
          includeWsInQr: cleaned.includeWsInQr,
        })
      : null;

    this.updateState({
      settings: cleaned,
      joinUrl,
    });

    if (
      prevSignalingUrl !== cleaned.signalingUrl &&
      (this.state.roomStatus === 'live' || this.state.roomStatus === 'connecting')
    ) {
      this.startRoom();
    }

    return { ok: true };
  }

  public async resumeAudio(): Promise<void> {
    const audioContextState = await this.audioMixer.ensureRunning();
    this.updateState({ audioContextState });
  }

  public setMasterVocalVolume(volume: number): void {
    const clamped = Math.min(1.5, Math.max(0, Number.isFinite(volume) ? volume : 1));
    void this.audioMixer.ensureRunning().then((audioContextState) => {
      if (!this.disposed && audioContextState !== this.state.audioContextState) {
        this.updateState({ audioContextState });
      }
    });
    this.audioMixer.setMasterVolume(clamped);
    this.updateState({ masterVocalVolume: clamped });
  }

  public setPeerVolume(clientId: string, volume: number): void {
    const clamped = Math.min(1.5, Math.max(0, Number.isFinite(volume) ? volume : 1));
    void this.audioMixer.ensureRunning().then((audioContextState) => {
      if (!this.disposed && audioContextState !== this.state.audioContextState) {
        this.updateState({ audioContextState });
      }
    });
    this.audioMixer.setPeerVolume(clientId, clamped);
    this.patchPeer(clientId, { volume: clamped });
  }

  public togglePeerHostMute(clientId: string): void {
    const peer = this.state.peers.find((p) => p.clientId === clientId);
    if (!peer) {
      return;
    }
    const nextMuted = !peer.hostMuted;
    this.audioMixer.setPeerMuted(clientId, nextMuted);
    this.webrtc?.setHostMute(clientId, nextMuted);
    this.patchPeer(clientId, { hostMuted: nextMuted });
  }

  public kickPeer(clientId: string): void {
    this.signaling?.kickClient(clientId, 'Dikeluarkan oleh Operator');
    this.removePeerLocally(clientId);
  }

  public async refreshYouTubeStatus(): Promise<void> {
    const status = await this.youtube.getStatus();
    if (this.disposed) {
      return;
    }

    if (!status || !status.found) {
      if (this.state.youtube.connected) {
        this.updateState({
          youtube: {
            ...this.state.youtube,
            connected: false,
            title: 'Buka tab YouTube untuk kontrol musik',
            paused: true,
          },
        });
      }
      return;
    }

    let targetVolume = this.state.youtube.targetVolume;
    let effectiveVolume = this.state.youtube.effectiveVolume;

    if (!this.hasOperatorSetYtVolume && !this.ducking.getIsDucked()) {
      this.ducking.setTargetVolume(status.volume);
      targetVolume = status.volume;
      effectiveVolume = status.volume;
    }

    this.updateState({
      youtube: {
        ...this.state.youtube,
        connected: true,
        title: status.title || 'YouTube',
        targetVolume,
        effectiveVolume,
        muted: status.muted,
        paused: status.paused,
      },
    });
  }

  public async setYouTubeVolume(volume: number): Promise<void> {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    this.hasOperatorSetYtVolume = true;
    const duckResult = this.ducking.setTargetVolume(clamped);

    this.updateState({
      youtube: {
        ...this.state.youtube,
        targetVolume: clamped,
        effectiveVolume: duckResult.effectiveVolume,
        muted: duckResult.effectiveVolume === 0,
        isDucked: duckResult.isDucked,
      },
    });

    const response = await this.youtube.setVolume(duckResult.effectiveVolume);
    if (this.disposed || !response) {
      return;
    }

    this.updateState({
      youtube: {
        ...this.state.youtube,
        connected: response.found,
        title: response.title || this.state.youtube.title,
        muted: response.muted,
        paused: response.paused,
      },
    });
  }

  public setDuckingEnabled(enabled: boolean): void {
    saveDuckingEnabled(enabled);
    const result = this.ducking.setEnabled(enabled);

    this.updateState({
      youtube: {
        ...this.state.youtube,
        duckingEnabled: enabled,
        isDucked: result.isDucked,
        effectiveVolume: result.effectiveVolume,
      },
    });

    if (result.changed && this.state.youtube.connected) {
      void this.youtube.setVolume(result.effectiveVolume);
    }
  }

  public sampleMeters(nowMs = Date.now()): MixerSampleSnapshot {
    const snapshot = this.audioMixer.sampleLevels();

    const duckResult = this.ducking.processSpeechLevel(snapshot.maxActiveRms, nowMs);
    if (duckResult.changed) {
      this.updateState({
        youtube: {
          ...this.state.youtube,
          isDucked: duckResult.isDucked,
          effectiveVolume: duckResult.effectiveVolume,
        },
      });
      if (this.state.youtube.connected) {
        void this.youtube.setVolume(duckResult.effectiveVolume);
      }
    }

    return snapshot;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.sessionSeq += 1;
    this.stopYouTubePolling();
    this.restoreDuckingIfActive();
    this.teardownRoomResources();
    await this.audioMixer.dispose();
  }

  private removePeerLocally(clientId: string): void {
    this.webrtc?.removePeer(clientId);
    this.audioMixer.removePeer(clientId);
    const filtered = this.state.peers.filter((p) => p.clientId !== clientId);
    if (filtered.length !== this.state.peers.length) {
      this.updateState({ peers: filtered });
    }
    if (filtered.length === 0) {
      this.restoreDuckingIfActive();
    }
  }

  private patchPeer(clientId: string, patch: Partial<PeerMicState>): void {
    let changed = false;
    const nextPeers = this.state.peers.map((peer) => {
      if (peer.clientId !== clientId) {
        return peer;
      }
      changed = true;
      return { ...peer, ...patch };
    });
    if (changed) {
      this.updateState({ peers: nextPeers });
    }
  }

  private restoreDuckingIfActive(): void {
    const result = this.ducking.reset();
    if (result.changed) {
      this.updateState({
        youtube: {
          ...this.state.youtube,
          isDucked: false,
          effectiveVolume: result.effectiveVolume,
        },
      });
      if (this.state.youtube.connected) {
        void this.youtube.setVolume(result.effectiveVolume);
      }
    }
  }

  private teardownRoomResources(): void {
    this.stopYouTubePolling();

    if (this.webrtc) {
      this.webrtc.closeAll();
      this.webrtc = null;
    }

    if (this.signaling) {
      this.signaling.disconnect();
      this.signaling = null;
    }

    for (const peer of this.state.peers) {
      this.audioMixer.removePeer(peer.clientId);
    }
  }

  private updateState(partial: Partial<OperatorState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
