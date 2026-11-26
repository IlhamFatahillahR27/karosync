// Mirrors signaling-server/src/types.ts for @karosync/client

export const WS_CLOSE_KICKED = 4001;
export const WS_CLOSE_ROOM_CLOSED = 4002;

export const MAX_CLIENT_NAME_LENGTH = 32;
export const ROOM_ID_LENGTH = 6;
export const HOST_PEER_ID = 'host' as const;
export const CONTROL_CHANNEL_LABEL = 'karosync-control' as const;

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

// Client -> Signaling Server messages

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

export interface PingMessage {
  type: 'PING';
  ts?: number;
}

export type ClientToServerMessage = JoinRoomMessage | SignalMessage | PingMessage;

// Signaling Server -> Client messages

export interface RoomJoinedMessage {
  type: 'ROOM_JOINED';
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

export type ServerToClientMessage =
  | RoomJoinedMessage
  | RelayedSignalMessage
  | KickedMessage
  | RoomClosedMessage
  | ErrorMessage
  | PongMessage;

// P2P DataChannel control messages (Host <-> Client)

export interface HostMuteControlMessage {
  type: 'HOST_MUTE';
  muted: boolean;
}

export interface SelfMuteControlMessage {
  type: 'SELF_MUTE';
  muted: boolean;
}

export type ControlMessage = HostMuteControlMessage | SelfMuteControlMessage;

const VALID_SDP_TYPES = new Set<SessionDescriptionPayload['type']>([
  'offer',
  'answer',
  'pranswer',
  'rollback',
]);

const VALID_ERROR_CODES = new Set<ErrorCode>([
  'INVALID_JSON',
  'INVALID_MESSAGE',
  'INVALID_PAYLOAD',
  'UNKNOWN_EVENT',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'CLIENT_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'FORBIDDEN',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSdp(raw: unknown): SessionDescriptionPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.type !== 'string' ||
    !VALID_SDP_TYPES.has(raw.type as SessionDescriptionPayload['type'])
  ) {
    return null;
  }
  if (raw.sdp !== undefined && typeof raw.sdp !== 'string') {
    return null;
  }

  const sdp: SessionDescriptionPayload = {
    type: raw.type as SessionDescriptionPayload['type'],
  };
  if (raw.sdp !== undefined) {
    sdp.sdp = raw.sdp;
  }
  return sdp;
}

function parseIceCandidate(raw: unknown): IceCandidatePayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.candidate !== undefined && typeof raw.candidate !== 'string') {
    return null;
  }
  if (raw.sdpMid !== undefined && raw.sdpMid !== null && typeof raw.sdpMid !== 'string') {
    return null;
  }
  if (
    raw.sdpMLineIndex !== undefined &&
    raw.sdpMLineIndex !== null &&
    typeof raw.sdpMLineIndex !== 'number'
  ) {
    return null;
  }
  if (
    raw.usernameFragment !== undefined &&
    raw.usernameFragment !== null &&
    typeof raw.usernameFragment !== 'string'
  ) {
    return null;
  }

  const candidate: IceCandidatePayload = {};
  if (raw.candidate !== undefined) candidate.candidate = raw.candidate;
  if (raw.sdpMid !== undefined) candidate.sdpMid = raw.sdpMid;
  if (raw.sdpMLineIndex !== undefined) candidate.sdpMLineIndex = raw.sdpMLineIndex;
  if (raw.usernameFragment !== undefined) candidate.usernameFragment = raw.usernameFragment;
  return candidate;
}

export function parseServerMessage(rawText: string): ServerToClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  switch (parsed.type) {
    case 'ROOM_JOINED': {
      if (
        typeof parsed.roomId !== 'string' ||
        typeof parsed.clientId !== 'string' ||
        typeof parsed.clientName !== 'string'
      ) {
        return null;
      }
      return {
        type: 'ROOM_JOINED',
        roomId: parsed.roomId,
        clientId: parsed.clientId,
        clientName: parsed.clientName,
      };
    }

    case 'SIGNAL': {
      if (typeof parsed.senderId !== 'string' || typeof parsed.targetId !== 'string') {
        return null;
      }
      const hasSdp = parsed.sdp !== undefined;
      const hasCandidate = parsed.candidate !== undefined;
      if (!hasSdp && !hasCandidate) {
        return null;
      }

      let sdp: SessionDescriptionPayload | undefined;
      if (hasSdp) {
        const validated = parseSdp(parsed.sdp);
        if (!validated) {
          return null;
        }
        sdp = validated;
      }

      let candidate: IceCandidatePayload | undefined;
      if (hasCandidate) {
        const validated = parseIceCandidate(parsed.candidate);
        if (!validated) {
          return null;
        }
        candidate = validated;
      }

      return {
        type: 'SIGNAL',
        senderId: parsed.senderId,
        targetId: parsed.targetId,
        ...(sdp !== undefined ? { sdp } : {}),
        ...(candidate !== undefined ? { candidate } : {}),
      };
    }

    case 'KICKED': {
      if (typeof parsed.roomId !== 'string' || typeof parsed.reason !== 'string') {
        return null;
      }
      return {
        type: 'KICKED',
        roomId: parsed.roomId,
        reason: parsed.reason,
      };
    }

    case 'ROOM_CLOSED': {
      if (typeof parsed.roomId !== 'string' || typeof parsed.reason !== 'string') {
        return null;
      }
      return {
        type: 'ROOM_CLOSED',
        roomId: parsed.roomId,
        reason: parsed.reason,
      };
    }

    case 'ERROR': {
      if (
        typeof parsed.code !== 'string' ||
        !VALID_ERROR_CODES.has(parsed.code as ErrorCode) ||
        typeof parsed.message !== 'string'
      ) {
        return null;
      }
      return {
        type: 'ERROR',
        code: parsed.code as ErrorCode,
        message: parsed.message,
      };
    }

    case 'PONG': {
      if (typeof parsed.serverTime !== 'number' || !Number.isFinite(parsed.serverTime)) {
        return null;
      }
      if (
        parsed.ts !== undefined &&
        (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts))
      ) {
        return null;
      }
      return {
        type: 'PONG',
        ...(parsed.ts !== undefined ? { ts: parsed.ts } : {}),
        serverTime: parsed.serverTime,
      };
    }

    default:
      return null;
  }
}

export function parseControlMessage(rawText: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  if (parsed.type === 'HOST_MUTE' && typeof parsed.muted === 'boolean') {
    return { type: 'HOST_MUTE', muted: parsed.muted };
  }

  if (parsed.type === 'SELF_MUTE' && typeof parsed.muted === 'boolean') {
    return { type: 'SELF_MUTE', muted: parsed.muted };
  }

  return null;
}
