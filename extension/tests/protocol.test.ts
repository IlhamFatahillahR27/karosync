import { describe, expect, it } from 'vitest';
import { parseControlMessage, parseHostServerMessage } from '../src/protocol';

describe('extension protocol parsers', () => {
  it('parses ROOM_CREATED, CLIENT_JOINED, and CLIENT_LEFT messages', () => {
    expect(parseHostServerMessage(JSON.stringify({ type: 'ROOM_CREATED', roomId: 'K7M2PX' }))).toEqual({
      type: 'ROOM_CREATED',
      roomId: 'K7M2PX',
    });

    expect(
      parseHostServerMessage(
        JSON.stringify({
          type: 'CLIENT_JOINED',
          roomId: 'K7M2PX',
          clientId: 'c1',
          clientName: 'Budi',
        }),
      ),
    ).toEqual({
      type: 'CLIENT_JOINED',
      roomId: 'K7M2PX',
      clientId: 'c1',
      clientName: 'Budi',
    });

    expect(
      parseHostServerMessage(
        JSON.stringify({
          type: 'CLIENT_LEFT',
          roomId: 'K7M2PX',
          clientId: 'c1',
          reason: 'kicked',
        }),
      ),
    ).toEqual({
      type: 'CLIENT_LEFT',
      roomId: 'K7M2PX',
      clientId: 'c1',
      reason: 'kicked',
    });
  });

  it('parses valid SIGNAL messages with sdp or candidate', () => {
    const sdpMsg = parseHostServerMessage(
      JSON.stringify({
        type: 'SIGNAL',
        senderId: 'c1',
        targetId: 'host',
        sdp: { type: 'offer', sdp: 'v=0...' },
      }),
    );
    expect(sdpMsg).toEqual({
      type: 'SIGNAL',
      senderId: 'c1',
      targetId: 'host',
      sdp: { type: 'offer', sdp: 'v=0...' },
    });

    const iceMsg = parseHostServerMessage(
      JSON.stringify({
        type: 'SIGNAL',
        senderId: 'c1',
        targetId: 'host',
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );
    expect(iceMsg).toEqual({
      type: 'SIGNAL',
      senderId: 'c1',
      targetId: 'host',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    });
  });

  it('rejects malformed or unknown server messages', () => {
    expect(parseHostServerMessage('not-json')).toBeNull();
    expect(parseHostServerMessage(JSON.stringify({ type: 'ROOM_CREATED', roomId: '' }))).toBeNull();
    expect(
      parseHostServerMessage(JSON.stringify({ type: 'SIGNAL', senderId: 'c1', targetId: 'host' })),
    ).toBeNull();
    expect(
      parseHostServerMessage(
        JSON.stringify({ type: 'CLIENT_LEFT', roomId: 'K7M2PX', clientId: 'c1', reason: 'other' }),
      ),
    ).toBeNull();
    expect(
      parseHostServerMessage(JSON.stringify({ type: 'ERROR', code: 'UNKNOWN', message: 'bad' })),
    ).toBeNull();
  });

  it('parses DataChannel control messages', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'HOST_MUTE', muted: true }))).toEqual({
      type: 'HOST_MUTE',
      muted: true,
    });
    expect(parseControlMessage(JSON.stringify({ type: 'SELF_MUTE', muted: false }))).toEqual({
      type: 'SELF_MUTE',
      muted: false,
    });
    expect(parseControlMessage(JSON.stringify({ type: 'SELF_MUTE', muted: 'yes' }))).toBeNull();
    expect(parseControlMessage('{bad')).toBeNull();
  });
});
