import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSignalingServer, type SignalingServerInstance } from '../src/server.js';
import {
  parseLaunchParams,
  resolveSignalingUrl,
} from '../../client-web/src/config';
import { SignalingClient } from '../../client-web/src/signaling-client';
import {
  WebRtcSender,
  type DataChannelLike as SenderDataChannelLike,
  type PeerConnectionLike as SenderPeerConnectionLike,
} from '../../client-web/src/webrtc-sender';
import { buildMicJoinUrl } from '../../extension/src/config';
import { HostSignalingClient } from '../../extension/src/host-signaling';
import {
  WebRtcReceiverManager,
  type DataChannelLike as ReceiverDataChannelLike,
  type PeerConnectionLike as ReceiverPeerConnectionLike,
} from '../../extension/src/webrtc-receiver';
import type { IceCandidatePayload, SessionDescriptionPayload } from '../src/types.js';

class LinkedDataChannel implements SenderDataChannelLike, ReceiverDataChannelLike {
  public readonly label: string;
  public readyState = 'open';
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public peer: LinkedDataChannel | null = null;

  constructor(label: string) {
    this.label = label;
  }

  public send(data: string): void {
    if (this.readyState !== 'open' || !this.peer || this.peer.readyState !== 'open') {
      return;
    }
    queueMicrotask(() => {
      this.peer?.onmessage?.({ data });
    });
  }

  public close(): void {
    this.readyState = 'closed';
    this.onclose?.({});
  }
}

class LinkedPeerConnection implements SenderPeerConnectionLike, ReceiverPeerConnectionLike {
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public remoteDescription: SessionDescriptionPayload | null = null;
  public onicecandidate:
    | ((event: { candidate: RTCIceCandidate | IceCandidatePayload | null }) => void)
    | null = null;
  public onconnectionstatechange: ((event: unknown) => void) | null = null;
  public oniceconnectionstatechange: ((event: unknown) => void) | null = null;
  public ondatachannel: ((event: { channel: LinkedDataChannel }) => void) | null = null;
  public ontrack: ((event: { track: MediaStreamTrack; streams: ReadonlyArray<MediaStream> }) => void) | null =
    null;

  public readonly receivedCandidates: IceCandidatePayload[] = [];
  private readonly side: 'sender' | 'receiver';
  private localStream: MediaStream | null = null;
  private localChannel: LinkedDataChannel | null = null;
  private peerRef: LinkedPeerConnection | null = null;

  constructor(side: 'sender' | 'receiver') {
    this.side = side;
  }

  public link(other: LinkedPeerConnection): void {
    this.peerRef = other;
    other.peerRef = this;
  }

  public addTrack(_track: MediaStreamTrack, ...streams: MediaStream[]): unknown {
    this.localStream = streams[0] ?? null;
    return {};
  }

  public createDataChannel(label: string): LinkedDataChannel {
    this.localChannel = new LinkedDataChannel(label);
    return this.localChannel;
  }

  public async createOffer(): Promise<SessionDescriptionPayload> {
    return { type: 'offer', sdp: 'v=0\r\no=karosync-mic 1 1 IN IP4 127.0.0.1\r\n' };
  }

  public async createAnswer(): Promise<SessionDescriptionPayload> {
    return { type: 'answer', sdp: 'v=0\r\no=karosync-operator 2 2 IN IP4 127.0.0.1\r\n' };
  }

  public async setLocalDescription(_description: SessionDescriptionPayload): Promise<void> {
    queueMicrotask(() => {
      this.onicecandidate?.({
        candidate: {
          candidate: `candidate:1 1 UDP 2122252543 192.168.1.${this.side === 'sender' ? '50' : '10'} 51234 typ host`,
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      });
    });
  }

  public async setRemoteDescription(description: SessionDescriptionPayload): Promise<void> {
    this.remoteDescription = description;

    // Once answer is set on sender, simulate ICE connection + media track + DataChannel open
    if (description.type === 'answer' && this.peerRef) {
      const receiver = this.peerRef;
      queueMicrotask(() => {
        if (this.localStream) {
          receiver.ontrack?.({
            track: { kind: 'audio' } as unknown as MediaStreamTrack,
            streams: [this.localStream],
          });
        }
        if (this.localChannel) {
          const remoteChannel = new LinkedDataChannel(this.localChannel.label);
          this.localChannel.peer = remoteChannel;
          remoteChannel.peer = this.localChannel;
          receiver.ondatachannel?.({ channel: remoteChannel });
          this.localChannel.onopen?.({});
          remoteChannel.onopen?.({});
        }
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        receiver.connectionState = 'connected';
        receiver.iceConnectionState = 'connected';
        this.onconnectionstatechange?.({});
        receiver.onconnectionstatechange?.({});
      });
    }
  }

  public async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    this.receivedCandidates.push(candidate);
  }

  public async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map<string, Record<string, unknown>>([
      ['local-1', { id: 'local-1', type: 'local-candidate', candidateType: 'host' }],
      [
        'pair-1',
        {
          id: 'pair-1',
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          localCandidateId: 'local-1',
          currentRoundTripTime: 0.008,
        },
      ],
    ]);
  }

  public close(): void {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('Cross-Workspace E2E Integration (Signaling + Client Mic + Extension Operator)', () => {
  let server: SignalingServerInstance;
  let wsProxyUrl: string;

  beforeEach(async () => {
    server = createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      maxClientsPerRoom: 8,
      heartbeatIntervalMs: 0,
    });
    const addr = await server.listen();
    wsProxyUrl = `ws://${addr.host}:${addr.port}/ws`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects Operator and multiple Mic Clients end-to-end with WebRTC signaling, DataChannel mute sync, kick, and room close', async () => {
    let createdRoomId = '';
    const joinedPeers: Array<{ clientId: string; clientName: string }> = [];
    const leftPeers: Array<{ clientId: string; reason: string }> = [];
    const receivedStreams = new Map<string, MediaStream>();
    const hostObservedSelfMute = new Map<string, boolean>();
    const hostPeerStates = new Map<string, RTCPeerConnectionState>();

    const peerPairs = new Map<string, { senderPc: LinkedPeerConnection; receiverPc: LinkedPeerConnection }>();

    let hostSignaling!: HostSignalingClient;
    const receiverManager = new WebRtcReceiverManager({
      statsPollIntervalMs: 0,
      peerConnectionFactory: () => {
        const receiverPc = new LinkedPeerConnection('receiver');
        // Link with the most recently prepared sender peer connection
        for (const pair of peerPairs.values()) {
          if (pair.receiverPc === null) {
            pair.receiverPc = receiverPc;
            pair.senderPc.link(receiverPc);
            break;
          }
        }
        return receiverPc;
      },
      callbacks: {
        sendSignal: (targetClientId, payload) => {
          hostSignaling.sendSignal(targetClientId, payload);
        },
        onStream: (clientId, stream) => {
          receivedStreams.set(clientId, stream);
        },
        onConnectionStateChange: (clientId, state) => {
          hostPeerStates.set(clientId, state);
        },
        onSelfMuteChange: (clientId, muted) => {
          hostObservedSelfMute.set(clientId, muted);
        },
      },
    });

    hostSignaling = new HostSignalingClient({
      url: wsProxyUrl,
      callbacks: {
        onRoomCreated: (msg) => {
          createdRoomId = msg.roomId;
        },
        onClientJoined: (msg) => {
          joinedPeers.push({ clientId: msg.clientId, clientName: msg.clientName });
          receiverManager.ensurePeer(msg.clientId);
        },
        onClientLeft: (msg) => {
          leftPeers.push({ clientId: msg.clientId, reason: msg.reason });
          receiverManager.removePeer(msg.clientId);
        },
        onSignal: (msg) => {
          void receiverManager.handleIncomingSignal(msg);
        },
        onError: (_code, message) => {
          throw new Error(`Unexpected host signaling error: ${message}`);
        },
        onClose: () => undefined,
      },
    });

    hostSignaling.connect();
    await waitFor(() => createdRoomId.length === 6);

    // 1. Operator builds QR URL -> Client parses ?room= and ?ws=
    const qrJoinUrl = buildMicJoinUrl({
      clientBaseUrl: 'https://karosync-demo.trycloudflare.com',
      roomId: createdRoomId,
      signalingUrl: wsProxyUrl,
      includeWsInQr: true,
    });
    const parsedUrl = new URL(qrJoinUrl);
    const launch = parseLaunchParams(parsedUrl.search);
    expect(launch.roomId).toBe(createdRoomId);
    expect(launch.fromQuery).toBe(true);
    const resolvedWs = resolveSignalingUrl({ queryWs: launch.querySignalingUrl });
    expect(resolvedWs).toBe(wsProxyUrl);

    // 2. Client 1 ("Budi") joins room and establishes WebRTC P2P through real signaling server
    let client1Id = '';
    let client1ConnState: RTCPeerConnectionState = 'new';
    let client1HostMuted = false;
    let client1KickedReason = '';
    let client1Sender: WebRtcSender | null = null;

    const senderPc1 = new LinkedPeerConnection('sender');
    peerPairs.set('slot-1', {
      senderPc: senderPc1,
      receiverPc: null as unknown as LinkedPeerConnection,
    });

    const fakeStream1 = {
      id: 'budi-mic-stream',
      getAudioTracks: () => [{ kind: 'audio', enabled: true } as unknown as MediaStreamTrack],
    } as unknown as MediaStream;

    const client1Signaling = new SignalingClient({
      url: resolvedWs,
      roomId: launch.roomId,
      clientName: 'Budi',
      callbacks: {
        onJoined: (msg) => {
          client1Id = msg.clientId;
          client1Sender = new WebRtcSender({
            stream: fakeStream1,
            statsPollIntervalMs: 0,
            peerConnectionFactory: () => senderPc1,
            callbacks: {
              sendSignal: (payload) => {
                client1Signaling.sendSignal(payload);
              },
              onConnectionStateChange: (state) => {
                client1ConnState = state;
              },
              onHostMuteChange: (muted) => {
                client1HostMuted = muted;
              },
            },
          });
          void client1Sender.startOffer();
        },
        onSignal: (msg) => {
          void client1Sender?.handleIncomingSignal(msg);
        },
        onKicked: (msg) => {
          client1KickedReason = msg.reason;
        },
        onRoomClosed: () => undefined,
        onError: (_code, message) => {
          throw new Error(`Unexpected client1 error: ${message}`);
        },
        onClose: () => undefined,
      },
    });

    client1Signaling.connect();

    await waitFor(
      () =>
        client1Id.length > 0 &&
        client1ConnState === 'connected' &&
        hostPeerStates.get(client1Id) === 'connected' &&
        receivedStreams.get(client1Id) === fakeStream1,
    );

    // Verify ICE candidates were relayed both ways across the real signaling server
    const pair1 = peerPairs.get('slot-1')!;
    await waitFor(
      () =>
        pair1.senderPc.receivedCandidates.length > 0 &&
        pair1.receiverPc.receivedCandidates.length > 0,
    );

    // 3. Bidirectional P2P DataChannel mute sync (Host Mute <-> Self Mute)
    receiverManager.setHostMute(client1Id, true);
    await waitFor(() => client1HostMuted === true);

    client1Sender!.sendSelfMute(true);
    await waitFor(() => hostObservedSelfMute.get(client1Id) === true);

    // 4. Client 2 ("Siti") joins concurrently
    let client2Id = '';
    let client2RoomClosedReason = '';
    const senderPc2 = new LinkedPeerConnection('sender');
    peerPairs.set('slot-2', {
      senderPc: senderPc2,
      receiverPc: null as unknown as LinkedPeerConnection,
    });
    const fakeStream2 = {
      id: 'siti-mic-stream',
      getAudioTracks: () => [{ kind: 'audio', enabled: true } as unknown as MediaStreamTrack],
    } as unknown as MediaStream;
    let client2Sender: WebRtcSender | null = null;

    const client2Signaling = new SignalingClient({
      url: resolvedWs,
      roomId: launch.roomId,
      clientName: 'Siti',
      callbacks: {
        onJoined: (msg) => {
          client2Id = msg.clientId;
          client2Sender = new WebRtcSender({
            stream: fakeStream2,
            statsPollIntervalMs: 0,
            peerConnectionFactory: () => senderPc2,
            callbacks: {
              sendSignal: (payload) => client2Signaling.sendSignal(payload),
              onConnectionStateChange: () => undefined,
              onHostMuteChange: () => undefined,
            },
          });
          void client2Sender.startOffer();
        },
        onSignal: (msg) => {
          void client2Sender?.handleIncomingSignal(msg);
        },
        onKicked: () => undefined,
        onRoomClosed: (msg) => {
          client2RoomClosedReason = msg.reason;
        },
        onError: (_code, message) => {
          throw new Error(`Unexpected client2 error: ${message}`);
        },
        onClose: () => undefined,
      },
    });

    client2Signaling.connect();
    await waitFor(() => client2Id.length > 0 && receivedStreams.get(client2Id) === fakeStream2);
    expect(joinedPeers).toHaveLength(2);
    expect(receiverManager.getPeerCount()).toBe(2);

    // 5. Operator kicks Client 1 -> Client 1 gets KICKED, Host gets CLIENT_LEFT
    hostSignaling.kickClient(client1Id, 'Feedback audio');
    await waitFor(() => client1KickedReason === 'Feedback audio');
    await waitFor(() => leftPeers.some((p) => p.clientId === client1Id && p.reason === 'kicked'));
    expect(receiverManager.getPeerCount()).toBe(1);

    // 6. Operator closes room -> remaining Client 2 receives ROOM_CLOSED
    hostSignaling.disconnect();
    await waitFor(() => client2RoomClosedReason === 'Host disconnected');

    client1Sender?.close();
    client2Sender?.close();
    client1Signaling.disconnect();
    client2Signaling.disconnect();
    receiverManager.closeAll();
  });
});
