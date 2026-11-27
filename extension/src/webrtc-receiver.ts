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

export interface RtpReceiverLike {
  playoutDelayHint?: number;
  jitterBufferTarget?: number;
}

export interface TrackEventLike {
  readonly track: MediaStreamTrack;
  readonly streams: ReadonlyArray<MediaStream>;
  readonly receiver?: RtpReceiverLike;
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
  statsTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const DEFAULT_STATS_RETRY_DELAY_MS = 2000;

export function preferLowLatencyOpusSdp(sdp: string | undefined): string | undefined {
  if (!sdp) {
    return sdp;
  }
  const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  if (!opusMatch?.[1]) {
    return sdp;
  }
  const payloadType = opusMatch[1];
  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const fmtpPrefix = `a=fmtp:${payloadType} `;
  let hasFmtp = false;
  let hasPtime = false;
  let hasMinPtime = false;

  const updated = lines.map((line) => {
    if (line.startsWith('a=ptime:')) {
      hasPtime = true;
      return 'a=ptime:10';
    }
    if (line.startsWith('a=minptime:')) {
      hasMinPtime = true;
      return 'a=minptime:10';
    }
    if (line.startsWith(fmtpPrefix)) {
      hasFmtp = true;
      let params = line.slice(fmtpPrefix.length);
      if (/minptime=\d+/i.test(params)) {
        params = params.replace(/minptime=\d+/i, 'minptime=10');
      } else {
        params = `${params};minptime=10`;
      }
      if (/useinbandfec=\d+/i.test(params)) {
        params = params.replace(/useinbandfec=\d+/i, 'useinbandfec=0');
      } else {
        params = `${params};useinbandfec=0`;
      }
      if (/stereo=\d+/i.test(params)) {
        params = params.replace(/stereo=\d+/i, 'stereo=0');
      } else {
        params = `${params};stereo=0`;
      }
      return `${fmtpPrefix}${params}`;
    }
    return line;
  });

  if (!hasFmtp) {
    const rtpmapIdx = updated.findIndex((line) =>
      line.startsWith(`a=rtpmap:${payloadType} `),
    );
    if (rtpmapIdx >= 0) {
      updated.splice(rtpmapIdx + 1, 0, `${fmtpPrefix}minptime=10;useinbandfec=0;stereo=0`);
    }
  }

  if (!hasPtime || !hasMinPtime) {
    const audioIdx = updated.findIndex((line) => line.startsWith('m=audio '));
    if (audioIdx >= 0) {
      const insertLines: string[] = [];
      if (!hasMinPtime) insertLines.push('a=minptime:10');
      if (!hasPtime) insertLines.push('a=ptime:10');
      updated.splice(audioIdx + 1, 0, ...insertLines);
    }
  }

  return updated.join(lineEnding);
}

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
    this.statsPollIntervalMs = options.statsPollIntervalMs ?? DEFAULT_STATS_RETRY_DELAY_MS;
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
      if (event.receiver) {
        try {
          if ('playoutDelayHint' in event.receiver) {
            event.receiver.playoutDelayHint = 0;
          }
          if ('jitterBufferTarget' in event.receiver) {
            event.receiver.jitterBufferTarget = 0;
          }
        } catch {
          // Non-fatal on browsers without jitter buffer hint support
        }
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
        const optimizedSdp = preferLowLatencyOpusSdp(answer.sdp);
        const payload: SessionDescriptionPayload = {
          type: answer.type,
          ...(optimizedSdp !== undefined ? { sdp: optimizedSdp } : {}),
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
    void this.pollConnectionRoute(entry, true);
  }

  private stopStatsPolling(entry: PeerEntry): void {
    if (entry.statsTimer !== null) {
      clearTimeout(entry.statsTimer);
      entry.statsTimer = null;
    }
  }

  private async pollConnectionRoute(entry: PeerEntry, allowRetry = false): Promise<void> {
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
        if (allowRetry && !entry.closed && this.statsPollIntervalMs > 0) {
          entry.statsTimer = setTimeout(() => {
            entry.statsTimer = null;
            void this.pollConnectionRoute(entry, false);
          }, this.statsPollIntervalMs);
        }
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
