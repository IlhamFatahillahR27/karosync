import type { WebSocket } from 'ws';

export const WS_CLOSE_KICKED = 4001;
export const WS_CLOSE_ROOM_CLOSED = 4002;

export const MAX_CLIENT_NAME_LENGTH = 32;
export const MAX_REASON_LENGTH = 200;
export const ROOM_ID_LENGTH = 6;
export const HOST_PEER_ID = 'host' as const;

export type ErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE'
  | 'INVALID_PAYLOAD'
  | 'UNKNOWN_EVENT'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'CLIENT_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'FORBIDDEN';

export interface SessionDescriptionPayload {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface IceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// Incoming messages (Host / Client -> Server)

export interface CreateRoomMessage {
  type: 'CREATE_ROOM';
}

export interface JoinRoomMessage {
  type: 'JOIN_ROOM';
  roomId: string;
  clientName: string;
}

export interface SignalMessage {
  type: 'SIGNAL';
  targetId: string;
  senderId?: string;
  sdp?: SessionDescriptionPayload;
  candidate?: IceCandidatePayload;
}

export interface KickClientMessage {
  type: 'KICK_CLIENT';
  clientId: string;
  reason?: string;
}

export interface PingMessage {
  type: 'PING';
  ts?: number;
}

export type IncomingMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | SignalMessage
  | KickClientMessage
  | PingMessage;

// Outgoing messages (Server -> Host / Client)

export interface RoomCreatedMessage {
  type: 'ROOM_CREATED';
  roomId: string;
}

export interface RoomJoinedMessage {
  type: 'ROOM_JOINED';
  roomId: string;
  clientId: string;
  clientName: string;
}

export interface ClientJoinedMessage {
  type: 'CLIENT_JOINED';
  roomId: string;
  clientId: string;
  clientName: string;
}

export interface RelayedSignalMessage {
  type: 'SIGNAL';
  senderId: string;
  targetId: string;
  sdp?: SessionDescriptionPayload;
  candidate?: IceCandidatePayload;
}

export interface KickedMessage {
  type: 'KICKED';
  roomId: string;
  reason: string;
}

export interface ClientLeftMessage {
  type: 'CLIENT_LEFT';
  roomId: string;
  clientId: string;
  reason: 'disconnected' | 'kicked';
}

export interface RoomClosedMessage {
  type: 'ROOM_CLOSED';
  roomId: string;
  reason: string;
}

export interface ErrorMessage {
  type: 'ERROR';
  code: ErrorCode;
  message: string;
}

export interface PongMessage {
  type: 'PONG';
  ts?: number;
  serverTime: number;
}

export type OutgoingMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | ClientJoinedMessage
  | RelayedSignalMessage
  | KickedMessage
  | ClientLeftMessage
  | RoomClosedMessage
  | ErrorMessage
  | PongMessage;

// Room & socket tracking structures

export interface ClientEntry {
  id: string;
  name: string;
  socket: WebSocket;
  joinedAt: number;
}

export interface Room {
  id: string;
  hostSocket: WebSocket;
  clients: Map<string, ClientEntry>;
  createdAt: number;
}

export type SocketMeta =
  | {
      role: 'host';
      roomId: string;
    }
  | {
      role: 'client';
      roomId: string;
      clientId: string;
    };

export interface ServerStats {
  rooms: number;
  clients: number;
  connections: number;
}
