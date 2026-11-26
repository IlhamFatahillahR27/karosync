import { describe, expect, it, vi } from 'vitest';
import {
  HostSignalingClient,
  WS_READY_STATE_OPEN,
  testSignalingConnection,
  type WebSocketLike,
} from '../src/host-signaling';

class FakeWebSocket implements WebSocketLike {
  public readyState = WS_READY_STATE_OPEN;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public sent: string[] = [];
  public closed = false;

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  public emitOpen(): void {
    this.onopen?.({});
  }

  public emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('HostSignalingClient', () => {
  it('sends CREATE_ROOM on open and dispatches host lifecycle events', () => {
    const ws = new FakeWebSocket();
    const onRoomCreated = vi.fn();
    const onClientJoined = vi.fn();
    const onClientLeft = vi.fn();
    const onSignal = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();

    const client = new HostSignalingClient({
      url: 'ws://localhost:8080',
      connectTimeoutMs: 0,
      webSocketFactory: () => ws,
      callbacks: {
        onRoomCreated,
        onClientJoined,
        onClientLeft,
        onSignal,
        onError,
        onClose,
      },
    });

    client.connect();
    ws.emitOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'CREATE_ROOM' });

    ws.emitMessage({ type: 'ROOM_CREATED', roomId: 'K7M2PX' });
    expect(onRoomCreated).toHaveBeenCalledWith({ type: 'ROOM_CREATED', roomId: 'K7M2PX' });

    ws.emitMessage({
      type: 'CLIENT_JOINED',
      roomId: 'K7M2PX',
      clientId: 'client-1',
      clientName: 'Budi',
    });
    expect(onClientJoined).toHaveBeenCalledTimes(1);

    client.sendSignal('client-1', { sdp: { type: 'answer', sdp: 'v=0' } });
    expect(JSON.parse(ws.sent[1]!)).toEqual({
      type: 'SIGNAL',
      targetId: 'client-1',
      sdp: { type: 'answer', sdp: 'v=0' },
    });

    client.kickClient('client-1', 'Noise');
    expect(JSON.parse(ws.sent[2]!)).toEqual({
      type: 'KICK_CLIENT',
      clientId: 'client-1',
      reason: 'Noise',
    });

    ws.emitMessage({
      type: 'CLIENT_LEFT',
      roomId: 'K7M2PX',
      clientId: 'client-1',
      reason: 'kicked',
    });
    expect(onClientLeft).toHaveBeenCalledTimes(1);

    client.disconnect();
    expect(ws.closed).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('triggers timeout error when ROOM_CREATED is not received in time', () => {
    vi.useFakeTimers();
    const ws = new FakeWebSocket();
    const onError = vi.fn();

    const client = new HostSignalingClient({
      url: 'ws://localhost:8080',
      connectTimeoutMs: 500,
      webSocketFactory: () => ws,
      callbacks: {
        onRoomCreated: vi.fn(),
        onClientJoined: vi.fn(),
        onClientLeft: vi.fn(),
        onSignal: vi.fn(),
        onError,
        onClose: vi.fn(),
      },
    });

    client.connect();
    vi.advanceTimersByTime(600);

    expect(onError).toHaveBeenCalledWith('TIMEOUT', expect.any(String));
    expect(ws.closed).toBe(true);
    vi.useRealTimers();
  });

  it('measures server ping via PING/PONG in testSignalingConnection and live sessions', async () => {
    const testWs = new FakeWebSocket();
    const promise = testSignalingConnection('ws://localhost:8080', {
      timeoutMs: 2000,
      webSocketFactory: () => testWs,
    });

    testWs.emitOpen();
    const sentPing = JSON.parse(testWs.sent[0]!) as { type: string; ts: number };
    expect(sentPing.type).toBe('PING');
    testWs.emitMessage({ type: 'PONG', ts: sentPing.ts, serverTime: Date.now() });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.pingMs).not.toBeNull();
    expect(testWs.closed).toBe(true);

    // Live HostSignalingClient ping reporting
    const liveWs = new FakeWebSocket();
    const onPingUpdate = vi.fn();
    const client = new HostSignalingClient({
      url: 'ws://localhost:8080',
      connectTimeoutMs: 0,
      pingIntervalMs: 5000,
      webSocketFactory: () => liveWs,
      callbacks: {
        onRoomCreated: vi.fn(),
        onClientJoined: vi.fn(),
        onClientLeft: vi.fn(),
        onSignal: vi.fn(),
        onPingUpdate,
        onError: vi.fn(),
        onClose: vi.fn(),
      },
    });

    client.connect();
    liveWs.emitOpen();
    liveWs.emitMessage({ type: 'ROOM_CREATED', roomId: 'K7M2PX' });
    const livePing = JSON.parse(liveWs.sent[1]!) as { type: string; ts: number };
    expect(livePing.type).toBe('PING');
    liveWs.emitMessage({ type: 'PONG', ts: livePing.ts, serverTime: Date.now() });
    expect(onPingUpdate).toHaveBeenCalledWith(expect.any(Number));
    client.disconnect();
  });
});
