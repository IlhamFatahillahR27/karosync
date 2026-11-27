import { DEFAULT_RTC_CONFIG } from './config';
import {
  CONTROL_CHANNEL_LABEL,
  parseControlMessage,
  type IceCandidatePayload,
  type RelayedSignalMessage,
  type SelfMuteControlMessage,
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

export interface PeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly remoteDescription: SessionDescriptionPayload | null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | IceCandidatePayload | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  oniceconnectionstatechange: ((event: unknown) => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): unknown;
  createDataChannel(label: string, init?: RTCDataChannelInit): DataChannelLike;
  createOffer(): Promise<SessionDescriptionPayload>;
  createAnswer(): Promise<SessionDescriptionPayload>;
  setLocalDescription(description: SessionDescriptionPayload): Promise<void>;
  setRemoteDescription(description: SessionDescriptionPayload): Promise<void>;
  addIceCandidate(candidate: IceCandidatePayload): Promise<void>;
  getStats(): Promise<Map<string, Record<string, unknown>>>;
  close(): void;
}

export interface WebRtcSenderCallbacks {
  sendSignal: (payload: { sdp?: SessionDescriptionPayload; candidate?: IceCandidatePayload }) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  onHostMuteChange: (muted: boolean) => void;
  onRouteInfoChange?: (info: RouteInfo | null) => void;
  onError?: (message: string) => void;
}

export interface WebRtcSenderOptions {
  stream: MediaStream;
  rtcConfig?: RTCConfiguration;
  initialSelfMuted?: boolean;
  statsPollIntervalMs?: number;
  peerConnectionFactory?: (config: RTCConfiguration) => PeerConnectionLike;
  callbacks: WebRtcSenderCallbacks;
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

export class WebRtcSender {
  private readonly callbacks: WebRtcSenderCallbacks;
  private readonly statsPollIntervalMs: number;
  private pc: PeerConnectionLike | null = null;
  private controlChannel: DataChannelLike | null = null;
  private pendingIceCandidates: IceCandidatePayload[] = [];
  private lastReportedState: RTCPeerConnectionState = 'new';
  private selfMuted: boolean;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: WebRtcSenderOptions) {
    this.callbacks = options.callbacks;
    this.selfMuted = options.initialSelfMuted ?? false;
    this.statsPollIntervalMs = options.statsPollIntervalMs ?? DEFAULT_STATS_RETRY_DELAY_MS;

    const rtcConfig = options.rtcConfig ?? DEFAULT_RTC_CONFIG;
    const factory =
      options.peerConnectionFactory ??
      ((config: RTCConfiguration) => new RTCPeerConnection(config) as unknown as PeerConnectionLike);

    const pc = factory(rtcConfig);
    this.pc = pc;

    for (const track of options.stream.getAudioTracks()) {
      pc.addTrack(track, options.stream);
    }

    const channel = pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true });
    this.attachControlChannel(channel);

    pc.ondatachannel = (event) => {
      if (event.channel.label === CONTROL_CHANNEL_LABEL) {
        this.attachControlChannel(event.channel);
      }
    };

    pc.onicecandidate = (event) => {
      if (this.closed || !event.candidate) {
        return;
      }
      const serialized = serializeCandidate(event.candidate);
      if (!serialized.candidate) {
        return;
      }
      this.callbacks.sendSignal({ candidate: serialized });
    };

    pc.onconnectionstatechange = () => {
      this.emitConnectionState();
    };

    pc.oniceconnectionstatechange = () => {
      this.emitConnectionState();
    };
  }

  public async startOffer(): Promise<void> {
    if (this.closed || !this.pc) {
      return;
    }

    const offer = await this.pc.createOffer();
    if (this.closed || !this.pc) {
      return;
    }

    const optimizedSdp = preferLowLatencyOpusSdp(offer.sdp);
    const payload: SessionDescriptionPayload = {
      type: offer.type,
      ...(optimizedSdp !== undefined ? { sdp: optimizedSdp } : {}),
    };

    await this.pc.setLocalDescription(payload);
    if (this.closed) {
      return;
    }

    this.callbacks.sendSignal({ sdp: payload });
  }

  public async handleIncomingSignal(msg: RelayedSignalMessage): Promise<void> {
    if (this.closed || !this.pc) {
      return;
    }

    if (msg.sdp) {
      if (msg.sdp.type === 'answer') {
        await this.pc.setRemoteDescription(msg.sdp);
        await this.flushPendingCandidates();
      } else if (msg.sdp.type === 'offer') {
        await this.pc.setRemoteDescription(msg.sdp);
        await this.flushPendingCandidates();
        if (this.closed || !this.pc) {
          return;
        }
        const answer = await this.pc.createAnswer();
        if (this.closed || !this.pc) {
          return;
        }
        const payload: SessionDescriptionPayload = {
          type: answer.type,
          ...(answer.sdp !== undefined ? { sdp: answer.sdp } : {}),
        };
        await this.pc.setLocalDescription(payload);
        if (!this.closed) {
          this.callbacks.sendSignal({ sdp: payload });
        }
      }
    }

    if (msg.candidate) {
      if (this.pc.remoteDescription) {
        await this.safeAddIceCandidate(msg.candidate);
      } else {
        this.pendingIceCandidates.push(msg.candidate);
      }
    }
  }

  public sendSelfMute(muted: boolean): void {
    this.selfMuted = muted;
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      return;
    }
    const payload: SelfMuteControlMessage = {
      type: 'SELF_MUTE',
      muted,
    };
    try {
      this.controlChannel.send(JSON.stringify(payload));
    } catch {
      // Ignore send failure while channel transitions
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopStatsPolling();
    this.pendingIceCandidates = [];

    if (this.controlChannel) {
      this.controlChannel.onopen = null;
      this.controlChannel.onmessage = null;
      this.controlChannel.onclose = null;
      try {
        this.controlChannel.close();
      } catch {
        // Ignore close errors
      }
      this.controlChannel = null;
    }

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ondatachannel = null;
      try {
        this.pc.close();
      } catch {
        // Ignore close errors
      }
      this.pc = null;
    }
  }

  private attachControlChannel(channel: DataChannelLike): void {
    this.controlChannel = channel;

    channel.onopen = () => {
      if (this.closed || this.controlChannel !== channel) {
        return;
      }
      this.sendSelfMute(this.selfMuted);
    };

    channel.onmessage = (event) => {
      if (this.closed || typeof event.data !== 'string') {
        return;
      }
      const parsed = parseControlMessage(event.data);
      if (parsed?.type === 'HOST_MUTE') {
        this.callbacks.onHostMuteChange(parsed.muted);
      }
    };
  }

  private resolveEffectiveState(): RTCPeerConnectionState {
    if (!this.pc) {
      return 'closed';
    }

    // Some mobile Safari builds update iceConnectionState before connectionState
    const connState = this.pc.connectionState;
    if (connState && connState !== 'new') {
      return connState;
    }

    switch (this.pc.iceConnectionState) {
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

  private emitConnectionState(): void {
    if (this.closed) {
      return;
    }
    const nextState = this.resolveEffectiveState();
    if (nextState === this.lastReportedState) {
      return;
    }
    this.lastReportedState = nextState;

    if (nextState === 'connected') {
      this.startStatsPolling();
    } else {
      this.stopStatsPolling();
      this.callbacks.onRouteInfoChange?.(null);
    }

    this.callbacks.onConnectionStateChange(nextState);
  }

  private async flushPendingCandidates(): Promise<void> {
    if (this.closed || !this.pc || this.pendingIceCandidates.length === 0) {
      return;
    }
    const queued = this.pendingIceCandidates;
    this.pendingIceCandidates = [];
    for (const candidate of queued) {
      if (this.closed) {
        break;
      }
      await this.safeAddIceCandidate(candidate);
    }
  }

  private async safeAddIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (this.closed || !this.pc) {
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // Non-fatal: some browsers reject empty/duplicate end-of-candidate markers
    }
  }

  private startStatsPolling(): void {
    if (!this.callbacks.onRouteInfoChange || this.statsPollIntervalMs <= 0) {
      return;
    }
    this.stopStatsPolling();
    void this.pollConnectionRoute(true);
  }

  private stopStatsPolling(): void {
    if (this.statsTimer !== null) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async pollConnectionRoute(allowRetry = false): Promise<void> {
    if (this.closed || !this.pc || !this.callbacks.onRouteInfoChange) {
      return;
    }

    try {
      const stats = await this.pc.getStats();
      if (this.closed) {
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
        if (allowRetry && !this.closed && this.statsPollIntervalMs > 0) {
          this.statsTimer = setTimeout(() => {
            this.statsTimer = null;
            void this.pollConnectionRoute(false);
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

      this.callbacks.onRouteInfoChange({
        candidateType,
        label: mapCandidateTypeLabel(candidateType),
        rttMs: rttSeconds !== null ? Math.round(rttSeconds * 1000) : null,
      });
    } catch {
      // Ignore transient stats errors
    }
  }
}
