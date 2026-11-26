import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createSignalingServer, type SignalingServerInstance } from '../src/server.js';
import {
  HOST_PEER_ID,
  ROOM_ID_LENGTH,
  WS_CLOSE_KICKED,
  WS_CLOSE_ROOM_CLOSED,
  type OutgoingMessage,
} from '../src/types.js';

class TestSocket {
  public readonly ws: WebSocket;
  private readonly queue: OutgoingMessage[] = [];
  private readonly waiters: Array<(msg: OutgoingMessage) => void> = [];
  private readonly closePromise: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;

    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString()) as OutgoingMessage;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        this.queue.push(parsed);
      }
    });

    this.closePromise = new Promise((resolve) => {
      ws.once('close', (code, reasonBuf) => {
        resolve({ code, reason: reasonBuf.toString() });
      });
    });
  }

  public static async connect(url: string): Promise<TestSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestSocket(ws);
  }

  public send(payload: unknown): void {
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  public nextMessage(timeoutMs = 2000): Promise<OutgoingMessage> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onMessage);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket message`));
      }, timeoutMs);

      const onMessage = (msg: OutgoingMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };

      this.waiters.push(onMessage);
    });
  }

  public waitForClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closePromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for socket close`)), timeoutMs);
      }),
    ]);
  }

  public async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.waitForClose();
  }
}

describe('KaroSync Signaling Server (Phase 1)', () => {
  let server: SignalingServerInstance;
  let wsUrl: string;
  let httpUrl: string;

  beforeEach(async () => {
    server = createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      maxClientsPerRoom: 2,
      heartbeatIntervalMs: 0,
    });
    const addr = await server.listen();
    wsUrl = `ws://${addr.host}:${addr.port}`;
    httpUrl = `http://${addr.host}:${addr.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('creates unique 6-character alphanumeric rooms on CREATE_ROOM', async () => {
    const host1 = await TestSocket.connect(wsUrl);
    const host2 = await TestSocket.connect(wsUrl);

    host1.send({ type: 'CREATE_ROOM' });
    const created1 = await host1.nextMessage();
    expect(created1.type).toBe('ROOM_CREATED');
    if (created1.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');
    expect(created1.roomId).toHaveLength(ROOM_ID_LENGTH);
    expect(created1.roomId).toMatch(/^[A-Z0-9]{6}$/);

    // Duplicate CREATE_ROOM from the same host is rejected
    host1.send({ type: 'CREATE_ROOM' });
    const dupErr = await host1.nextMessage();
    expect(dupErr).toMatchObject({ type: 'ERROR', code: 'ALREADY_IN_ROOM' });

    // Second host gets a different roomId
    host2.send({ type: 'CREATE_ROOM' });
    const created2 = await host2.nextMessage();
    expect(created2.type).toBe('ROOM_CREATED');
    if (created2.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');
    expect(created2.roomId).not.toBe(created1.roomId);

    await host1.close();
    await host2.close();
  });

  it('allows clients to join a room (case-insensitive) and notifies host', async () => {
    const host = await TestSocket.connect(wsUrl);
    host.send({ type: 'CREATE_ROOM' });
    const created = await host.nextMessage();
    if (created.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');

    const client1 = await TestSocket.connect(wsUrl);
    client1.send({
      type: 'JOIN_ROOM',
      roomId: created.roomId.toLowerCase(),
      clientName: '  Budi  ',
    });

    const joined = await client1.nextMessage();
    const hostNotif = await host.nextMessage();

    expect(joined).toMatchObject({
      type: 'ROOM_JOINED',
      roomId: created.roomId,
      clientName: 'Budi',
    });
    if (joined.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    expect(hostNotif).toEqual({
      type: 'CLIENT_JOINED',
      roomId: created.roomId,
      clientId: joined.clientId,
      clientName: 'Budi',
    });

    // Second client joins, third client rejected by maxClientsPerRoom = 2
    const client2 = await TestSocket.connect(wsUrl);
    client2.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Siti' });
    await client2.nextMessage();
    await host.nextMessage();

    const client3 = await TestSocket.connect(wsUrl);
    client3.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Andi' });
    const fullErr = await client3.nextMessage();
    expect(fullErr).toMatchObject({ type: 'ERROR', code: 'ROOM_FULL' });

    // Non-existent room error
    client3.send({ type: 'JOIN_ROOM', roomId: 'ZZZZZZ', clientName: 'Andi' });
    const notFoundErr = await client3.nextMessage();
    expect(notFoundErr).toMatchObject({ type: 'ERROR', code: 'ROOM_NOT_FOUND' });

    await client3.close();
    await client2.close();
    await client1.close();
    await host.close();
  });

  it('relays WebRTC SDP and ICE SIGNAL messages between host and client with verified senderId', async () => {
    const host = await TestSocket.connect(wsUrl);
    host.send({ type: 'CREATE_ROOM' });
    const created = await host.nextMessage();
    if (created.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');

    const client1 = await TestSocket.connect(wsUrl);
    client1.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Mic 1' });
    const joined1 = await client1.nextMessage();
    await host.nextMessage();
    if (joined1.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    const client2 = await TestSocket.connect(wsUrl);
    client2.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Mic 2' });
    const joined2 = await client2.nextMessage();
    await host.nextMessage();
    if (joined2.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    // Client -> Host SDP offer (server overrides spoofed senderId)
    client1.send({
      type: 'SIGNAL',
      senderId: 'spoofed-id',
      targetId: HOST_PEER_ID,
      sdp: { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1' },
    });

    const hostReceivedOffer = await host.nextMessage();
    expect(hostReceivedOffer).toEqual({
      type: 'SIGNAL',
      senderId: joined1.clientId,
      targetId: HOST_PEER_ID,
      sdp: { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1' },
    });

    // Host -> Client SDP answer
    host.send({
      type: 'SIGNAL',
      targetId: joined1.clientId,
      sdp: { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1' },
    });

    const clientReceivedAnswer = await client1.nextMessage();
    expect(clientReceivedAnswer).toEqual({
      type: 'SIGNAL',
      senderId: HOST_PEER_ID,
      targetId: joined1.clientId,
      sdp: { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1' },
    });

    // Client -> Host ICE candidate
    client1.send({
      type: 'SIGNAL',
      targetId: HOST_PEER_ID,
      candidate: {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.50 51234 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });

    const hostReceivedIce = await host.nextMessage();
    expect(hostReceivedIce).toEqual({
      type: 'SIGNAL',
      senderId: joined1.clientId,
      targetId: HOST_PEER_ID,
      candidate: {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.50 51234 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });

    // Client -> Client signaling is forbidden
    client1.send({
      type: 'SIGNAL',
      targetId: joined2.clientId,
      candidate: { candidate: 'candidate:2' },
    });
    const forbiddenErr = await client1.nextMessage();
    expect(forbiddenErr).toMatchObject({ type: 'ERROR', code: 'FORBIDDEN' });

    // Host -> unknown target returns TARGET_NOT_FOUND
    host.send({
      type: 'SIGNAL',
      targetId: 'non-existent-client',
      candidate: { candidate: 'candidate:3' },
    });
    const targetErr = await host.nextMessage();
    expect(targetErr).toMatchObject({ type: 'ERROR', code: 'TARGET_NOT_FOUND' });

    await client2.close();
    await client1.close();
    await host.close();
  });

  it('supports KICK_CLIENT from host and blocks non-host kick attempts', async () => {
    const host = await TestSocket.connect(wsUrl);
    host.send({ type: 'CREATE_ROOM' });
    const created = await host.nextMessage();
    if (created.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');

    const client1 = await TestSocket.connect(wsUrl);
    client1.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Mic 1' });
    const joined1 = await client1.nextMessage();
    await host.nextMessage();
    if (joined1.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    const client2 = await TestSocket.connect(wsUrl);
    client2.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Mic 2' });
    const joined2 = await client2.nextMessage();
    await host.nextMessage();
    if (joined2.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    // Non-host cannot kick
    client1.send({ type: 'KICK_CLIENT', clientId: joined2.clientId });
    const kickErr = await client1.nextMessage();
    expect(kickErr).toMatchObject({ type: 'ERROR', code: 'FORBIDDEN' });

    // Host kicks client1
    host.send({
      type: 'KICK_CLIENT',
      clientId: joined1.clientId,
      reason: 'Audio feedback',
    });

    const kickedMsg = await client1.nextMessage();
    expect(kickedMsg).toEqual({
      type: 'KICKED',
      roomId: created.roomId,
      reason: 'Audio feedback',
    });

    const closedInfo = await client1.waitForClose();
    expect(closedInfo.code).toBe(WS_CLOSE_KICKED);

    const hostLeftMsg = await host.nextMessage();
    expect(hostLeftMsg).toEqual({
      type: 'CLIENT_LEFT',
      roomId: created.roomId,
      clientId: joined1.clientId,
      reason: 'kicked',
    });

    // client2 remains connected in room
    expect(server.roomManager.getRoom(created.roomId)?.clients.size).toBe(1);

    await client2.close();
    await host.close();
  });

  it('auto-cleans client on disconnect and tears down entire room when host disconnects', async () => {
    const host = await TestSocket.connect(wsUrl);
    host.send({ type: 'CREATE_ROOM' });
    const created = await host.nextMessage();
    if (created.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');

    const client1 = await TestSocket.connect(wsUrl);
    client1.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Mic 1' });
    const joined1 = await client1.nextMessage();
    await host.nextMessage();
    if (joined1.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    const client2 = await TestSocket.connect(wsUrl);
    client2.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Mic 2' });
    const joined2 = await client2.nextMessage();
    await host.nextMessage();
    if (joined2.type !== 'ROOM_JOINED') throw new Error('Expected ROOM_JOINED');

    // Client 1 disconnects -> host gets CLIENT_LEFT
    await client1.close();
    const clientLeft = await host.nextMessage();
    expect(clientLeft).toEqual({
      type: 'CLIENT_LEFT',
      roomId: created.roomId,
      clientId: joined1.clientId,
      reason: 'disconnected',
    });
    expect(server.roomManager.getRoom(created.roomId)?.clients.size).toBe(1);

    // Host disconnects -> remaining client2 gets ROOM_CLOSED + close(4002), room deleted
    await host.close();

    const roomClosed = await client2.nextMessage();
    expect(roomClosed).toEqual({
      type: 'ROOM_CLOSED',
      roomId: created.roomId,
      reason: 'Host disconnected',
    });

    const client2Closed = await client2.waitForClose();
    expect(client2Closed.code).toBe(WS_CLOSE_ROOM_CLOSED);

    expect(server.roomManager.getRoom(created.roomId)).toBeUndefined();
    expect(server.roomManager.getStats(0)).toEqual({ rooms: 0, clients: 0, connections: 0 });
  });

  it('handles malformed messages gracefully and exposes /health endpoint stats', async () => {
    const host = await TestSocket.connect(wsUrl);

    host.send('not-json{{{');
    expect(await host.nextMessage()).toMatchObject({ type: 'ERROR', code: 'INVALID_JSON' });

    host.send({ type: 'UNKNOWN_THING' });
    expect(await host.nextMessage()).toMatchObject({ type: 'ERROR', code: 'UNKNOWN_EVENT' });

    host.send({ type: 'JOIN_ROOM', roomId: 'ABC123', clientName: '   ' });
    expect(await host.nextMessage()).toMatchObject({ type: 'ERROR', code: 'INVALID_PAYLOAD' });

    // Server still healthy and functional
    host.send({ type: 'CREATE_ROOM' });
    const created = await host.nextMessage();
    if (created.type !== 'ROOM_CREATED') throw new Error('Expected ROOM_CREATED');

    const client = await TestSocket.connect(wsUrl);
    client.send({ type: 'JOIN_ROOM', roomId: created.roomId, clientName: 'Tester' });
    await client.nextMessage();
    await host.nextMessage();

    const res = await fetch(`${httpUrl}/health`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as {
      status: string;
      rooms: number;
      clients: number;
      connections: number;
    };
    expect(health.status).toBe('ok');
    expect(health.rooms).toBe(1);
    expect(health.clients).toBe(1);
    expect(health.connections).toBe(2);

    await client.close();
    await host.close();
  });
});
