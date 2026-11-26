import { describe, expect, it, vi } from 'vitest';
import { CONTROL_CHANNEL_LABEL, type IceCandidatePayload, type SessionDescriptionPayload } from '../src/protocol';
import {
  WebRtcReceiverManager,
  type DataChannelLike,
  type PeerConnectionLike,
  type TrackEventLike,
} from '../src/webrtc-receiver';

class FakeDataChannel implements DataChannelLike {
  public readonly label: string;
  public readyState = 'open';
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public sent: string[] = [];
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
}

class FakePeerConnection implements PeerConnectionLike {
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public remoteDescription: SessionDescriptionPayload | null = null;
  public localDescription: SessionDescriptionPayload | null = null;
  public addedCandidates: IceCandidatePayload[] = [];
  public closed = false;

  public onicecandidate: ((event: { candidate: RTCIceCandidate | IceCandidatePayload | null }) => void) | null =
    null;
  public onconnectionstatechange: ((event: unknown) => void) | null = null;
  public oniceconnectionstatechange: ((event: unknown) => void) | null = null;
  public ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null;
  public ontrack: ((event: TrackEventLike) => void) | null = null;

  public async createAnswer(): Promise<SessionDescriptionPayload> {
    return { type: 'answer', sdp: 'v=0\r\nfake-answer' };
  }

  public async setLocalDescription(description: SessionDescriptionPayload): Promise<void> {
    this.localDescription = description;
  }

  public async setRemoteDescription(description: SessionDescriptionPayload): Promise<void> {
    this.remoteDescription = description;
  }

  public async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  public async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map([
      ['cand-1', { id: 'cand-1', type: 'local-candidate', candidateType: 'host' }],
      [
        'pair-1',
        {
          id: 'pair-1',
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          localCandidateId: 'cand-1',
          currentRoundTripTime: 0.006,
        },
      ],
    ]);
  }

  public close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

describe('WebRtcReceiverManager', () => {
  it('handles multi-peer offer/answer, queued ICE candidates, ontrack, and DataChannel mute sync', async () => {
    const createdPcs: FakePeerConnection[] = [];
    const sendSignal = vi.fn();
    const onStream = vi.fn();
    const onConnectionStateChange = vi.fn();
    const onSelfMuteChange = vi.fn();
    const onRouteInfoChange = vi.fn();

    const manager = new WebRtcReceiverManager({
      statsPollIntervalMs: 0,
      peerConnectionFactory: () => {
        const pc = new FakePeerConnection();
        createdPcs.push(pc);
        return pc;
      },
      callbacks: {
        sendSignal,
        onStream,
        onConnectionStateChange,
        onSelfMuteChange,
        onRouteInfoChange,
      },
    });

    // Queue ICE candidate arriving before offer
    await manager.handleIncomingSignal({
      type: 'SIGNAL',
      senderId: 'client-a',
      targetId: 'host',
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(createdPcs).toHaveLength(1);
    expect(createdPcs[0]!.addedCandidates).toHaveLength(0);

    // Handle SDP offer -> sets remote desc, flushes candidate, replies with SDP answer
    await manager.handleIncomingSignal({
      type: 'SIGNAL',
      senderId: 'client-a',
      targetId: 'host',
      sdp: { type: 'offer', sdp: 'v=0\r\nfake-offer' },
    });
    expect(createdPcs[0]!.addedCandidates).toHaveLength(1);
    expect(sendSignal).toHaveBeenCalledWith('client-a', {
      sdp: { type: 'answer', sdp: 'v=0\r\nfake-answer' },
    });

    // Second concurrent peer
    manager.ensurePeer('client-b');
    expect(manager.getPeerCount()).toBe(2);

    // Remote stream arrives
    const fakeStream = { id: 'stream-a' } as unknown as MediaStream;
    createdPcs[0]!.ontrack?.({
      track: {} as MediaStreamTrack,
      streams: [fakeStream],
    });
    expect(onStream).toHaveBeenCalledWith('client-a', fakeStream);

    // Pre-mute before DataChannel opens -> syncs HOST_MUTE automatically when channel arrives
    manager.setHostMute('client-a', true);
    const channel = new FakeDataChannel(CONTROL_CHANNEL_LABEL);
    createdPcs[0]!.ondatachannel?.({ channel });
    expect(channel.sent).toEqual([JSON.stringify({ type: 'HOST_MUTE', muted: true })]);

    // Client reports SELF_MUTE over DataChannel
    channel.onmessage?.({ data: JSON.stringify({ type: 'SELF_MUTE', muted: true }) });
    expect(onSelfMuteChange).toHaveBeenCalledWith('client-a', true);

    // Cleanup single peer and remaining peers
    manager.removePeer('client-a');
    expect(createdPcs[0]!.closed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(manager.getPeerCount()).toBe(1);

    manager.closeAll();
    expect(createdPcs[1]!.closed).toBe(true);
    expect(manager.getPeerCount()).toBe(0);
  });
});
