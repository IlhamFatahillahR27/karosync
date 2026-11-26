import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_CHANNEL_LABEL,
  type IceCandidatePayload,
  type SessionDescriptionPayload,
} from '../src/protocol';
import {
  WebRtcSender,
  type DataChannelLike,
  type PeerConnectionLike,
  type RouteInfo,
} from '../src/webrtc-sender';

class FakeDataChannel implements DataChannelLike {
  public readonly label: string;
  public readyState = 'connecting';
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public readonly sent: string[] = [];
  public closed = false;

  constructor(label: string) {
    this.label = label;
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }

  public open(): void {
    this.readyState = 'open';
    this.onopen?.({});
  }

  public receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakePeerConnection implements PeerConnectionLike {
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public remoteDescription: SessionDescriptionPayload | null = null;
  public localDescription: SessionDescriptionPayload | null = null;

  public onicecandidate: ((event: { candidate: RTCIceCandidate | IceCandidatePayload | null }) => void) | null =
    null;
  public onconnectionstatechange: ((event: unknown) => void) | null = null;
  public oniceconnectionstatechange: ((event: unknown) => void) | null = null;
  public ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null;

  public readonly addedTracks: MediaStreamTrack[] = [];
  public readonly addedIceCandidates: IceCandidatePayload[] = [];
  public createdChannel: FakeDataChannel | null = null;
  public closed = false;
  public statsMap = new Map<string, Record<string, unknown>>();

  public addTrack(track: MediaStreamTrack): unknown {
    this.addedTracks.push(track);
    return {};
  }

  public createDataChannel(label: string): DataChannelLike {
    const channel = new FakeDataChannel(label);
    this.createdChannel = channel;
    return channel;
  }

  public async createOffer(): Promise<SessionDescriptionPayload> {
    return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  }

  public async createAnswer(): Promise<SessionDescriptionPayload> {
    return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  }

  public async setLocalDescription(description: SessionDescriptionPayload): Promise<void> {
    this.localDescription = description;
  }

  public async setRemoteDescription(description: SessionDescriptionPayload): Promise<void> {
    this.remoteDescription = description;
  }

  public async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    this.addedIceCandidates.push(candidate);
  }

  public async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return this.statsMap;
  }

  public close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

function createFakeStream(): MediaStream {
  const fakeTrack = { kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
  return {
    getAudioTracks: () => [fakeTrack],
    getTracks: () => [fakeTrack],
  } as unknown as MediaStream;
}

describe('WebRtcSender', () => {
  it('adds audio track, creates offer, buffers pre-SDP ICE candidates, and relays local ICE', async () => {
    const fakePc = new FakePeerConnection();
    const sentSignals: Array<{ sdp?: SessionDescriptionPayload; candidate?: IceCandidatePayload }> =
      [];

    const sender = new WebRtcSender({
      stream: createFakeStream(),
      statsPollIntervalMs: 0,
      peerConnectionFactory: () => fakePc,
      callbacks: {
        sendSignal: (payload) => sentSignals.push(payload),
        onConnectionStateChange: vi.fn(),
        onHostMuteChange: vi.fn(),
      },
    });

    expect(fakePc.addedTracks).toHaveLength(1);
    expect(fakePc.createdChannel?.label).toBe(CONTROL_CHANNEL_LABEL);

    await sender.startOffer();
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.sdp?.type).toBe('offer');

    // Candidate arriving before remoteDescription should be queued
    await sender.handleIncomingSignal({
      type: 'SIGNAL',
      senderId: 'host',
      targetId: 'client-1',
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(fakePc.addedIceCandidates).toHaveLength(0);

    // Answer sets remoteDescription and flushes queued candidates
    await sender.handleIncomingSignal({
      type: 'SIGNAL',
      senderId: 'host',
      targetId: 'client-1',
      sdp: { type: 'answer', sdp: 'v=0\r\n' },
    });
    expect(fakePc.remoteDescription?.type).toBe('answer');
    expect(fakePc.addedIceCandidates).toEqual([
      { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    ]);

    // Local ICE candidate should be forwarded via sendSignal
    fakePc.onicecandidate?.({
      candidate: { candidate: 'candidate:local-lan', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(sentSignals[1]).toEqual({
      candidate: { candidate: 'candidate:local-lan', sdpMid: '0', sdpMLineIndex: 0 },
    });

    sender.close();
    expect(fakePc.closed).toBe(true);
    expect(fakePc.createdChannel?.closed).toBe(true);
  });

  it('handles HOST_MUTE and SELF_MUTE over karosync-control DataChannel and inspects LAN route stats', async () => {
    const fakePc = new FakePeerConnection();
    const hostMuteChanges: boolean[] = [];
    const routeUpdates: Array<RouteInfo | null> = [];
    const stateChanges: RTCPeerConnectionState[] = [];

    fakePc.statsMap.set('local-1', {
      id: 'local-1',
      type: 'local-candidate',
      candidateType: 'host',
    });
    fakePc.statsMap.set('pair-1', {
      id: 'pair-1',
      type: 'candidate-pair',
      nominated: true,
      state: 'succeeded',
      localCandidateId: 'local-1',
      currentRoundTripTime: 0.012,
    });

    const sender = new WebRtcSender({
      stream: createFakeStream(),
      initialSelfMuted: false,
      statsPollIntervalMs: 60_000,
      peerConnectionFactory: () => fakePc,
      callbacks: {
        sendSignal: vi.fn(),
        onConnectionStateChange: (state) => stateChanges.push(state),
        onHostMuteChange: (muted) => hostMuteChanges.push(muted),
        onRouteInfoChange: (info) => routeUpdates.push(info),
      },
    });

    const channel = fakePc.createdChannel;
    expect(channel).not.toBeNull();
    channel?.open();
    // Initial sync sent on channel open
    expect(channel?.sent).toEqual([JSON.stringify({ type: 'SELF_MUTE', muted: false })]);

    sender.sendSelfMute(true);
    expect(channel?.sent[1]).toBe(JSON.stringify({ type: 'SELF_MUTE', muted: true }));

    channel?.receive({ type: 'HOST_MUTE', muted: true });
    channel?.receive({ type: 'HOST_MUTE', muted: false });
    expect(hostMuteChanges).toEqual([true, false]);

    // Transition to connected triggers stats inspection
    fakePc.connectionState = 'connected';
    fakePc.onconnectionstatechange?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(stateChanges).toEqual(['connected']);
    expect(routeUpdates).toContainEqual({
      candidateType: 'host',
      label: 'LAN P2P',
      rttMs: 12,
    });

    sender.close();
  });

  it('responds with an SDP answer if host initiates a renegotiation offer', async () => {
    const fakePc = new FakePeerConnection();
    const sentSignals: Array<{ sdp?: SessionDescriptionPayload; candidate?: IceCandidatePayload }> =
      [];

    const sender = new WebRtcSender({
      stream: createFakeStream(),
      statsPollIntervalMs: 0,
      peerConnectionFactory: () => fakePc,
      callbacks: {
        sendSignal: (payload) => sentSignals.push(payload),
        onConnectionStateChange: vi.fn(),
        onHostMuteChange: vi.fn(),
      },
    });

    await sender.handleIncomingSignal({
      type: 'SIGNAL',
      senderId: 'host',
      targetId: 'client-1',
      sdp: { type: 'offer', sdp: 'v=0\r\n' },
    });

    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.sdp?.type).toBe('answer');
    sender.close();
  });
});
