// Mirrors signaling-server/src/types.ts and client-web/src/protocol.ts for @karosync/extension (Host role)

export const HOST_PEER_ID = 'host' as const;
export const CONTROL_CHANNEL_LABEL = 'karosync-control' as const;
export const ROOM_ID_LENGTH = 6;
export const MAX_CLIENT_NAME_LENGTH = 32;

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

// Host -> Signaling Server messages

export interface CreateRoomMessage {
  type: 'CREATE_ROOM';
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

export type HostToServerMessage =
  | CreateRoomMessage
  | SignalMessage
  | KickClientMessage
  | PingMessage;

// Signaling Server -> Host messages

export interface RoomCreatedMessage {
  type: 'ROOM_CREATED';
  roomId: string;
}

export interface ClientJoinedMessage {
  type: 'CLIENT_JOINED';
  roomId: string;
  clientId: string;
  clientName: string;
}

export interface ClientLeftMessage {
  type: 'CLIENT_LEFT';
  roomId: string;
  clientId: string;
  reason: 'disconnected' | 'kicked';
}

export interface RelayedSignalMessage {
  type: 'SIGNAL';
  senderId: string;
  targetId: string;
  sdp?: SessionDescriptionPayload;
  candidate?: IceCandidatePayload;
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

export type ServerToHostMessage =
  | RoomCreatedMessage
  | ClientJoinedMessage
  | ClientLeftMessage
  | RelayedSignalMessage
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

// Side Panel <-> Content Script messages (YouTube control)

export type YouTubeControlMessage =
  | { type: 'GET_YT_STATUS' }
  | { type: 'SET_YT_VOLUME'; volume: number; muted?: boolean };

export interface YouTubeStatusResponse {
  found: boolean;
  volume: number;
  muted: boolean;
  paused: boolean;
  title: string;
  url: string;
}

export interface YouTubeActionResponse extends YouTubeStatusResponse {
  ok: boolean;
}

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

export function parseHostServerMessage(rawText: string): ServerToHostMessage | null {
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
    case 'ROOM_CREATED': {
      if (typeof parsed.roomId !== 'string' || parsed.roomId.length === 0) {
        return null;
      }
      return {
        type: 'ROOM_CREATED',
        roomId: parsed.roomId,
      };
    }

    case 'CLIENT_JOINED': {
      if (
        typeof parsed.roomId !== 'string' ||
        typeof parsed.clientId !== 'string' ||
        typeof parsed.clientName !== 'string'
      ) {
        return null;
      }
      return {
        type: 'CLIENT_JOINED',
        roomId: parsed.roomId,
        clientId: parsed.clientId,
        clientName: parsed.clientName,
      };
    }

    case 'CLIENT_LEFT': {
      if (
        typeof parsed.roomId !== 'string' ||
        typeof parsed.clientId !== 'string' ||
        (parsed.reason !== 'disconnected' && parsed.reason !== 'kicked')
      ) {
        return null;
      }
      return {
        type: 'CLIENT_LEFT',
        roomId: parsed.roomId,
        clientId: parsed.clientId,
        reason: parsed.reason,
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
