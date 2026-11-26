import { DEFAULT_RTC_CONFIG } from './config';
import {
  CONTROL_CHANNEL_LABEL,
  parseControlMessage,
  type HostMuteControlMessage,
  type IceCandidatePayload,
  type RelayedSignalMessage,
  type SessionDescriptionPayload,
} from './protocol';

export interface RouteInfo {
  candidateType: 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';
  label: string;
  rttMs: number | null;
}

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface TrackEventLike {
  readonly track: MediaStreamTrack;
  readonly streams: ReadonlyArray<MediaStream>;
}

export interface PeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly remoteDescription: SessionDescriptionPayload | null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | IceCandidatePayload | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  oniceconnectionstatechange: ((event: unknown) => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
  ontrack: ((event: TrackEventLike) => void) | null;
  createAnswer(): Promise<SessionDescriptionPayload>;
  setLocalDescription(description: SessionDescriptionPayload): Promise<void>;
  setRemoteDescription(description: SessionDescriptionPayload): Promise<void>;
  addIceCandidate(candidate: IceCandidatePayload): Promise<void>;
  getStats(): Promise<Map<string, Record<string, unknown>>>;
  close(): void;
}

export interface WebRtcReceiverCallbacks {
  sendSignal: (
    targetClientId: string,
    payload: { sdp?: SessionDescriptionPayload; candidate?: IceCandidatePayload },
  ) => void;
  onStream: (clientId: string, stream: MediaStream) => void;
  onConnectionStateChange: (clientId: string, state: RTCPeerConnectionState) => void;
  onSelfMuteChange: (clientId: string, muted: boolean) => void;
  onRouteInfoChange?: (clientId: string, info: RouteInfo | null) => void;
}

export interface WebRtcReceiverManagerOptions {
  rtcConfig?: RTCConfiguration;
  statsPollIntervalMs?: number;
  peerConnectionFactory?: (config: RTCConfiguration) => PeerConnectionLike;
  mediaStreamFactory?: (tracks: MediaStreamTrack[]) => MediaStream;
  callbacks: WebRtcReceiverCallbacks;
}

interface PeerEntry {
  clientId: string;
  pc: PeerConnectionLike;
  controlChannel: DataChannelLike | null;
  pendingIceCandidates: IceCandidatePayload[];
  hostMuted: boolean;
  lastReportedState: RTCPeerConnectionState;
  statsTimer: ReturnType<typeof setInterval> | null;
  closed: boolean;
}

const DEFAULT_STATS_POLL_INTERVAL_MS = 3000;

function mapCandidateTypeLabel(candidateType: RouteInfo['candidateType']): string {
  switch (candidateType) {
    case 'host':
      return 'LAN P2P';
    case 'srflx':
      return 'STUN P2P';
    case 'prflx':
      return 'Direct P2P';
    case 'relay':
      return 'Relay';
    default:
      return 'WebRTC';
  }
}

function serializeCandidate(
  candidate: RTCIceCandidate | IceCandidatePayload,
): IceCandidatePayload {
  if ('toJSON' in candidate && typeof candidate.toJSON === 'function') {
    const json = candidate.toJSON();
    return {
      ...(json.candidate !== undefined ? { candidate: json.candidate } : {}),
      ...(json.sdpMid !== undefined ? { sdpMid: json.sdpMid } : {}),
      ...(json.sdpMLineIndex !== undefined ? { sdpMLineIndex: json.sdpMLineIndex } : {}),
      ...(json.usernameFragment !== undefined
        ? { usernameFragment: json.usernameFragment }
        : {}),
    };
  }

  const raw = candidate as IceCandidatePayload;
  return {
    ...(raw.candidate !== undefined ? { candidate: raw.candidate } : {}),
    ...(raw.sdpMid !== undefined ? { sdpMid: raw.sdpMid } : {}),
    ...(raw.sdpMLineIndex !== undefined ? { sdpMLineIndex: raw.sdpMLineIndex } : {}),
    ...(raw.usernameFragment !== undefined ? { usernameFragment: raw.usernameFragment } : {}),
  };
}

export class WebRtcReceiverManager {
  private readonly rtcConfig: RTCConfiguration;
  private readonly statsPollIntervalMs: number;
  private readonly peerConnectionFactory: (config: RTCConfiguration) => PeerConnectionLike;
  private readonly mediaStreamFactory: (tracks: MediaStreamTrack[]) => MediaStream;
  private readonly callbacks: WebRtcReceiverCallbacks;
  private readonly peers = new Map<string, PeerEntry>();

  constructor(options: WebRtcReceiverManagerOptions) {
    this.rtcConfig = options.rtcConfig ?? DEFAULT_RTC_CONFIG;
    this.statsPollIntervalMs = options.statsPollIntervalMs ?? DEFAULT_STATS_POLL_INTERVAL_MS;
    this.peerConnectionFactory =
      options.peerConnectionFactory ??
      ((config: RTCConfiguration) => new RTCPeerConnection(config) as unknown as PeerConnectionLike);
    this.mediaStreamFactory =
      options.mediaStreamFactory ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));
    this.callbacks = options.callbacks;
  }

  public getPeerCount(): number {
    return this.peers.size;
  }

  public hasPeer(clientId: string): boolean {
    return this.peers.has(clientId);
  }

  public ensurePeer(clientId: string): void {
    if (this.peers.has(clientId)) {
      return;
    }

    const pc = this.peerConnectionFactory(this.rtcConfig);
    const entry: PeerEntry = {
      clientId,
      pc,
      controlChannel: null,
      pendingIceCandidates: [],
      hostMuted: false,
      lastReportedState: 'new',
      statsTimer: null,
      closed: false,
    };

    this.peers.set(clientId, entry);

    pc.onicecandidate = (event) => {
      if (entry.closed || !event.candidate) {
        return;
      }
      const serialized = serializeCandidate(event.candidate);
      if (!serialized.candidate) {
        return;
      }
      this.callbacks.sendSignal(clientId, { candidate: serialized });
    };

    pc.ontrack = (event) => {
      if (entry.closed) {
        return;
      }
      const stream = event.streams[0] ?? this.mediaStreamFactory([event.track]);
      this.callbacks.onStream(clientId, stream);
    };

    pc.ondatachannel = (event) => {
      if (entry.closed || event.channel.label !== CONTROL_CHANNEL_LABEL) {
        return;
      }
      this.attachControlChannel(entry, event.channel);
    };

    pc.onconnectionstatechange = () => {
      this.emitConnectionState(entry);
    };

    pc.oniceconnectionstatechange = () => {
      this.emitConnectionState(entry);
    };
  }

  public async handleIncomingSignal(msg: RelayedSignalMessage): Promise<void> {
    const clientId = msg.senderId;
    if (!clientId) {
      return;
    }

    this.ensurePeer(clientId);
    const entry = this.peers.get(clientId);
    if (!entry || entry.closed) {
      return;
    }

    if (msg.sdp) {
      if (msg.sdp.type === 'offer') {
        await entry.pc.setRemoteDescription(msg.sdp);
        await this.flushPendingCandidates(entry);
        if (entry.closed) {
          return;
        }
        const answer = await entry.pc.createAnswer();
        if (entry.closed) {
          return;
        }
        const payload: SessionDescriptionPayload = {
          type: answer.type,
          ...(answer.sdp !== undefined ? { sdp: answer.sdp } : {}),
        };
        await entry.pc.setLocalDescription(payload);
        if (!entry.closed) {
          this.callbacks.sendSignal(clientId, { sdp: payload });
        }
      } else if (msg.sdp.type === 'answer') {
        await entry.pc.setRemoteDescription(msg.sdp);
        await this.flushPendingCandidates(entry);
      }
    }

    if (msg.candidate && !entry.closed) {
      if (entry.pc.remoteDescription) {
        await this.safeAddIceCandidate(entry, msg.candidate);
      } else {
        entry.pendingIceCandidates.push(msg.candidate);
      }
    }
  }

  public setHostMute(clientId: string, muted: boolean): void {
    const entry = this.peers.get(clientId);
    if (!entry || entry.closed) {
      return;
    }
    entry.hostMuted = muted;
    this.sendHostMute(entry, muted);
  }

  public removePeer(clientId: string): void {
    const entry = this.peers.get(clientId);
    if (!entry) {
      return;
    }
    this.peers.delete(clientId);
    this.teardownEntry(entry);
  }

  public closeAll(): void {
    const entries = Array.from(this.peers.values());
    this.peers.clear();
    for (const entry of entries) {
      this.teardownEntry(entry);
    }
  }

  private attachControlChannel(entry: PeerEntry, channel: DataChannelLike): void {
    entry.controlChannel = channel;

    channel.onopen = () => {
      if (entry.closed || entry.controlChannel !== channel) {
        return;
      }
      this.sendHostMute(entry, entry.hostMuted);
    };

    channel.onmessage = (event) => {
      if (entry.closed || typeof event.data !== 'string') {
        return;
      }
      const parsed = parseControlMessage(event.data);
      if (parsed?.type === 'SELF_MUTE') {
        this.callbacks.onSelfMuteChange(entry.clientId, parsed.muted);
      }
    };

    if (channel.readyState === 'open') {
      this.sendHostMute(entry, entry.hostMuted);
    }
  }

  private sendHostMute(entry: PeerEntry, muted: boolean): void {
    if (!entry.controlChannel || entry.controlChannel.readyState !== 'open') {
      return;
    }
    const payload: HostMuteControlMessage = {
      type: 'HOST_MUTE',
      muted,
    };
    try {
      entry.controlChannel.send(JSON.stringify(payload));
    } catch {
      // Ignore transient send error during channel close
    }
  }

  private resolveEffectiveState(entry: PeerEntry): RTCPeerConnectionState {
    const connState = entry.pc.connectionState;
    if (connState && connState !== 'new') {
      return connState;
    }

    switch (entry.pc.iceConnectionState) {
      case 'checking':
        return 'connecting';
      case 'connected':
      case 'completed':
        return 'connected';
      case 'disconnected':
        return 'disconnected';
      case 'failed':
        return 'failed';
      case 'closed':
        return 'closed';
      default:
        return connState || 'new';
    }
  }

  private emitConnectionState(entry: PeerEntry): void {
    if (entry.closed) {
      return;
    }
    const nextState = this.resolveEffectiveState(entry);
    if (nextState === entry.lastReportedState) {
      return;
    }
    entry.lastReportedState = nextState;

    if (nextState === 'connected') {
      this.startStatsPolling(entry);
    } else {
      this.stopStatsPolling(entry);
      this.callbacks.onRouteInfoChange?.(entry.clientId, null);
    }

    this.callbacks.onConnectionStateChange(entry.clientId, nextState);
  }

  private async flushPendingCandidates(entry: PeerEntry): Promise<void> {
    if (entry.closed || entry.pendingIceCandidates.length === 0) {
      return;
    }
    const queued = entry.pendingIceCandidates;
    entry.pendingIceCandidates = [];
    for (const candidate of queued) {
      if (entry.closed) {
        break;
      }
      await this.safeAddIceCandidate(entry, candidate);
    }
  }

  private async safeAddIceCandidate(
    entry: PeerEntry,
    candidate: IceCandidatePayload,
  ): Promise<void> {
    if (entry.closed) {
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // Non-fatal: ignore malformed/duplicate end-of-candidate markers
    }
  }

  private startStatsPolling(entry: PeerEntry): void {
    if (!this.callbacks.onRouteInfoChange || this.statsPollIntervalMs <= 0) {
      return;
    }
    this.stopStatsPolling(entry);
    void this.pollConnectionRoute(entry);
    entry.statsTimer = setInterval(() => {
      void this.pollConnectionRoute(entry);
    }, this.statsPollIntervalMs);
  }

  private stopStatsPolling(entry: PeerEntry): void {
    if (entry.statsTimer !== null) {
      clearInterval(entry.statsTimer);
      entry.statsTimer = null;
    }
  }

  private async pollConnectionRoute(entry: PeerEntry): Promise<void> {
    if (entry.closed || !this.callbacks.onRouteInfoChange) {
      return;
    }
    try {
      const stats = await entry.pc.getStats();
      if (entry.closed) {
        return;
      }

      let activePair: Record<string, unknown> | null = null;
      const localCandidates = new Map<string, Record<string, unknown>>();

      stats.forEach((report) => {
        if (report.type === 'local-candidate' && typeof report.id === 'string') {
          localCandidates.set(report.id, report);
        } else if (
          report.type === 'candidate-pair' &&
          (report.nominated === true || report.state === 'succeeded')
        ) {
          if (!activePair || report.nominated === true) {
            activePair = report;
          }
        }
      });

      if (!activePair) {
        return;
      }

      const pair = activePair as Record<string, unknown>;
      const localCandidateId =
        typeof pair.localCandidateId === 'string' ? pair.localCandidateId : '';
      const localCandidate = localCandidates.get(localCandidateId);
      const rawType =
        localCandidate && typeof localCandidate.candidateType === 'string'
          ? localCandidate.candidateType
          : 'unknown';

      const candidateType: RouteInfo['candidateType'] =
        rawType === 'host' ||
        rawType === 'srflx' ||
        rawType === 'prflx' ||
        rawType === 'relay'
          ? rawType
          : 'unknown';

      const rttSeconds =
        typeof pair.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime)
          ? pair.currentRoundTripTime
          : null;

      this.callbacks.onRouteInfoChange(entry.clientId, {
        candidateType,
        label: mapCandidateTypeLabel(candidateType),
        rttMs: rttSeconds !== null ? Math.round(rttSeconds * 1000) : null,
      });
    } catch {
      // Ignore transient WebRTC stats errors
    }
  }

  private teardownEntry(entry: PeerEntry): void {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    this.stopStatsPolling(entry);
    entry.pendingIceCandidates = [];

    if (entry.controlChannel) {
      entry.controlChannel.onopen = null;
      entry.controlChannel.onmessage = null;
      entry.controlChannel.onclose = null;
      try {
        entry.controlChannel.close();
      } catch {
        // Ignore teardown errors
      }
      entry.controlChannel = null;
    }

    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.ondatachannel = null;
    entry.pc.ontrack = null;
    try {
      entry.pc.close();
    } catch {
      // Ignore teardown errors
    }
  }
}
