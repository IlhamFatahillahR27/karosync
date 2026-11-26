import {
  MAX_CLIENT_NAME_LENGTH,
  MAX_REASON_LENGTH,
  type ErrorCode,
  type IceCandidatePayload,
  type IncomingMessage,
  type SessionDescriptionPayload,
} from './types.js';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

const VALID_SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSdp(raw: unknown): SessionDescriptionPayload | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.type !== 'string' || !VALID_SDP_TYPES.has(raw.type)) {
    return null;
  }

  if (raw.sdp !== undefined && typeof raw.sdp !== 'string') {
    return null;
  }

  const result: SessionDescriptionPayload = {
    type: raw.type as SessionDescriptionPayload['type'],
  };
  if (raw.sdp !== undefined) {
    result.sdp = raw.sdp;
  }
  return result;
}

function validateIceCandidate(raw: unknown): IceCandidatePayload | null {
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

  const result: IceCandidatePayload = {};
  if (raw.candidate !== undefined) result.candidate = raw.candidate;
  if (raw.sdpMid !== undefined) result.sdpMid = raw.sdpMid;
  if (raw.sdpMLineIndex !== undefined) result.sdpMLineIndex = raw.sdpMLineIndex;
  if (raw.usernameFragment !== undefined) result.usernameFragment = raw.usernameFragment;
  return result;
}

export function parseIncomingMessage(rawText: string): ValidationResult<IncomingMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      code: 'INVALID_JSON',
      message: 'Message must be valid JSON.',
    };
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: 'Message must be a JSON object with a string "type" field.',
    };
  }

  switch (parsed.type) {
    case 'CREATE_ROOM':
      return {
        ok: true,
        value: { type: 'CREATE_ROOM' },
      };

    case 'JOIN_ROOM': {
      if (typeof parsed.roomId !== 'string' || typeof parsed.clientName !== 'string') {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: 'JOIN_ROOM requires string "roomId" and "clientName".',
        };
      }

      const roomId = parsed.roomId.trim().toUpperCase();
      const clientName = parsed.clientName.trim();

      if (roomId.length === 0) {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: '"roomId" cannot be empty.',
        };
      }

      if (clientName.length === 0 || clientName.length > MAX_CLIENT_NAME_LENGTH) {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: `"clientName" must be between 1 and ${MAX_CLIENT_NAME_LENGTH} characters.`,
        };
      }

      return {
        ok: true,
        value: {
          type: 'JOIN_ROOM',
          roomId,
          clientName,
        },
      };
    }

    case 'SIGNAL': {
      if (typeof parsed.targetId !== 'string' || parsed.targetId.trim().length === 0) {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: 'SIGNAL requires a non-empty string "targetId".',
        };
      }

      const hasSdp = parsed.sdp !== undefined;
      const hasCandidate = parsed.candidate !== undefined;
      if (!hasSdp && !hasCandidate) {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: 'SIGNAL requires at least one of "sdp" or "candidate".',
        };
      }

      let sdp: SessionDescriptionPayload | undefined;
      if (hasSdp) {
        const validated = validateSdp(parsed.sdp);
        if (!validated) {
          return {
            ok: false,
            code: 'INVALID_PAYLOAD',
            message: 'Invalid "sdp" payload in SIGNAL message.',
          };
        }
        sdp = validated;
      }

      let candidate: IceCandidatePayload | undefined;
      if (hasCandidate) {
        const validated = validateIceCandidate(parsed.candidate);
        if (!validated) {
          return {
            ok: false,
            code: 'INVALID_PAYLOAD',
            message: 'Invalid "candidate" payload in SIGNAL message.',
          };
        }
        candidate = validated;
      }

      return {
        ok: true,
        value: {
          type: 'SIGNAL',
          targetId: parsed.targetId.trim(),
          ...(sdp !== undefined ? { sdp } : {}),
          ...(candidate !== undefined ? { candidate } : {}),
        },
      };
    }

    case 'KICK_CLIENT': {
      if (typeof parsed.clientId !== 'string' || parsed.clientId.trim().length === 0) {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: 'KICK_CLIENT requires a non-empty string "clientId".',
        };
      }

      if (parsed.reason !== undefined && typeof parsed.reason !== 'string') {
        return {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: '"reason" must be a string when provided.',
        };
      }

      const trimmedReason = parsed.reason?.trim().slice(0, MAX_REASON_LENGTH);

      return {
        ok: true,
        value: {
          type: 'KICK_CLIENT',
          clientId: parsed.clientId.trim(),
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        },
      };
    }

    default:
      return {
        ok: false,
        code: 'UNKNOWN_EVENT',
        message: `Unsupported event type "${parsed.type}".`,
      };
  }
}
