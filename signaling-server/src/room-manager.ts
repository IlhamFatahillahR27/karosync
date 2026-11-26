import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  HOST_PEER_ID,
  ROOM_ID_LENGTH,
  WS_CLOSE_KICKED,
  WS_CLOSE_ROOM_CLOSED,
  type ClientEntry,
  type ErrorCode,
  type JoinRoomMessage,
  type KickClientMessage,
  type OutgoingMessage,
  type RelayedSignalMessage,
  type Room,
  type ServerStats,
  type SignalMessage,
  type SocketMeta,
} from './types.js';
import { parseIncomingMessage } from './validation.js';

// Unambiguous uppercase alphanumeric alphabet (excludes 0, O, 1, I, L)
const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface RoomManagerOptions {
  maxClientsPerRoom?: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly socketMeta = new Map<WebSocket, SocketMeta>();
  private readonly maxClientsPerRoom: number;

  constructor(options: RoomManagerOptions = {}) {
    this.maxClientsPerRoom = options.maxClientsPerRoom ?? 8;
  }

  public handleRawMessage(socket: WebSocket, rawText: string): void {
    const result = parseIncomingMessage(rawText);
    if (!result.ok) {
      this.sendError(socket, result.code, result.message);
      return;
    }

    const msg = result.value;
    switch (msg.type) {
      case 'CREATE_ROOM':
        this.handleCreateRoom(socket);
        break;
      case 'JOIN_ROOM':
        this.handleJoinRoom(socket, msg);
        break;
      case 'SIGNAL':
        this.handleSignal(socket, msg);
        break;
      case 'KICK_CLIENT':
        this.handleKickClient(socket, msg);
        break;
      case 'PING':
        this.send(socket, {
          type: 'PONG',
          ...(msg.ts !== undefined ? { ts: msg.ts } : {}),
          serverTime: Date.now(),
        });
        break;
    }
  }

  public handleCreateRoom(socket: WebSocket): void {
    if (this.socketMeta.has(socket)) {
      this.sendError(
        socket,
        'ALREADY_IN_ROOM',
        'This connection is already associated with an active room.',
      );
      return;
    }

    const roomId = this.generateUniqueRoomId();
    const room: Room = {
      id: roomId,
      hostSocket: socket,
      clients: new Map<string, ClientEntry>(),
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    this.socketMeta.set(socket, { role: 'host', roomId });

    this.send(socket, {
      type: 'ROOM_CREATED',
      roomId,
    });
  }

  public handleJoinRoom(socket: WebSocket, msg: JoinRoomMessage): void {
    if (this.socketMeta.has(socket)) {
      this.sendError(
        socket,
        'ALREADY_IN_ROOM',
        'This connection is already associated with an active room.',
      );
      return;
    }

    const room = this.rooms.get(msg.roomId);
    if (!room) {
      this.sendError(socket, 'ROOM_NOT_FOUND', `Room "${msg.roomId}" was not found.`);
      return;
    }

    if (room.clients.size >= this.maxClientsPerRoom) {
      this.sendError(
        socket,
        'ROOM_FULL',
        `Room "${msg.roomId}" has reached the maximum capacity of ${this.maxClientsPerRoom} clients.`,
      );
      return;
    }

    const clientId = randomUUID();
    const clientEntry: ClientEntry = {
      id: clientId,
      name: msg.clientName,
      socket,
      joinedAt: Date.now(),
    };

    room.clients.set(clientId, clientEntry);
    this.socketMeta.set(socket, {
      role: 'client',
      roomId: room.id,
      clientId,
    });

    this.send(socket, {
      type: 'ROOM_JOINED',
      roomId: room.id,
      clientId,
      clientName: clientEntry.name,
    });

    this.send(room.hostSocket, {
      type: 'CLIENT_JOINED',
      roomId: room.id,
      clientId,
      clientName: clientEntry.name,
    });
  }

  public handleSignal(socket: WebSocket, msg: SignalMessage): void {
    const meta = this.socketMeta.get(socket);
    if (!meta) {
      this.sendError(socket, 'NOT_IN_ROOM', 'Join or create a room before sending SIGNAL messages.');
      return;
    }

    const room = this.rooms.get(meta.roomId);
    if (!room) {
      this.sendError(socket, 'ROOM_NOT_FOUND', 'Associated room no longer exists.');
      return;
    }

    if (meta.role === 'host') {
      const targetClient = room.clients.get(msg.targetId);
      if (!targetClient) {
        this.sendError(
          socket,
          'TARGET_NOT_FOUND',
          `Client "${msg.targetId}" is not connected to room "${room.id}".`,
        );
        return;
      }

      const relayed: RelayedSignalMessage = {
        type: 'SIGNAL',
        senderId: HOST_PEER_ID,
        targetId: targetClient.id,
        ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}),
        ...(msg.candidate !== undefined ? { candidate: msg.candidate } : {}),
      };
      this.send(targetClient.socket, relayed);
      return;
    }

    // Star topology: clients may only signal the room host
    if (msg.targetId !== HOST_PEER_ID) {
      this.sendError(socket, 'FORBIDDEN', 'Clients can only relay SIGNAL messages to "host".');
      return;
    }

    const relayed: RelayedSignalMessage = {
      type: 'SIGNAL',
      senderId: meta.clientId,
      targetId: HOST_PEER_ID,
      ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}),
      ...(msg.candidate !== undefined ? { candidate: msg.candidate } : {}),
    };
    this.send(room.hostSocket, relayed);
  }

  public handleKickClient(socket: WebSocket, msg: KickClientMessage): void {
    const meta = this.socketMeta.get(socket);
    if (!meta) {
      this.sendError(socket, 'NOT_IN_ROOM', 'You must host a room to kick clients.');
      return;
    }

    if (meta.role !== 'host') {
      this.sendError(socket, 'FORBIDDEN', 'Only the room host can kick clients.');
      return;
    }

    const room = this.rooms.get(meta.roomId);
    if (!room) {
      this.sendError(socket, 'ROOM_NOT_FOUND', 'Associated room no longer exists.');
      return;
    }

    const targetClient = room.clients.get(msg.clientId);
    if (!targetClient) {
      this.sendError(
        socket,
        'CLIENT_NOT_FOUND',
        `Client "${msg.clientId}" was not found in room "${room.id}".`,
      );
      return;
    }

    // Remove state before closing to avoid duplicate CLIENT_LEFT notifications on close
    room.clients.delete(targetClient.id);
    this.socketMeta.delete(targetClient.socket);

    const reason = msg.reason ?? 'Removed by host';

    this.send(targetClient.socket, {
      type: 'KICKED',
      roomId: room.id,
      reason,
    });

    if (
      targetClient.socket.readyState === WebSocket.OPEN ||
      targetClient.socket.readyState === WebSocket.CONNECTING
    ) {
      targetClient.socket.close(WS_CLOSE_KICKED, reason);
    }

    this.send(room.hostSocket, {
      type: 'CLIENT_LEFT',
      roomId: room.id,
      clientId: targetClient.id,
      reason: 'kicked',
    });
  }

  public handleDisconnect(socket: WebSocket): void {
    const meta = this.socketMeta.get(socket);
    if (!meta) {
      return;
    }

    this.socketMeta.delete(socket);

    const room = this.rooms.get(meta.roomId);
    if (!room) {
      return;
    }

    if (meta.role === 'client') {
      const removed = room.clients.delete(meta.clientId);
      if (removed) {
        this.send(room.hostSocket, {
          type: 'CLIENT_LEFT',
          roomId: room.id,
          clientId: meta.clientId,
          reason: 'disconnected',
        });
      }
      return;
    }

    // Host disconnected: tear down the entire room and notify all clients
    this.rooms.delete(room.id);

    const closeReason = 'Host disconnected';
    for (const client of room.clients.values()) {
      this.socketMeta.delete(client.socket);
      this.send(client.socket, {
        type: 'ROOM_CLOSED',
        roomId: room.id,
        reason: closeReason,
      });

      if (
        client.socket.readyState === WebSocket.OPEN ||
        client.socket.readyState === WebSocket.CONNECTING
      ) {
        client.socket.close(WS_CLOSE_ROOM_CLOSED, closeReason);
      }
    }

    room.clients.clear();
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public getStats(activeConnections: number): ServerStats {
    let clientCount = 0;
    for (const room of this.rooms.values()) {
      clientCount += room.clients.size;
    }

    return {
      rooms: this.rooms.size,
      clients: clientCount,
      connections: activeConnections,
    };
  }

  public clear(): void {
    this.rooms.clear();
    this.socketMeta.clear();
  }

  private generateUniqueRoomId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const bytes = randomBytes(ROOM_ID_LENGTH);
      let id = '';
      for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
        const byte = bytes[i] ?? 0;
        id += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length];
      }
      if (!this.rooms.has(id)) {
        return id;
      }
    }
    throw new Error('Failed to generate a unique room ID.');
  }

  private send(socket: WebSocket, message: OutgoingMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(socket: WebSocket, code: ErrorCode, message: string): void {
    this.send(socket, {
      type: 'ERROR',
      code,
      message,
    });
  }
}
