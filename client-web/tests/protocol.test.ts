import { describe, expect, it } from 'vitest';
import { parseControlMessage, parseServerMessage } from '../src/protocol';

describe('protocol parsers', () => {
  it('parses valid ROOM_JOINED messages', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: 'ROOM_JOINED',
        roomId: 'K7M2PX',
        clientId: 'client-123',
        clientName: 'Budi',
      }),
    );

    expect(parsed).toEqual({
      type: 'ROOM_JOINED',
      roomId: 'K7M2PX',
      clientId: 'client-123',
      clientName: 'Budi',
    });
  });

  it('parses relayed SIGNAL messages with SDP and ICE candidate', () => {
    const withSdp = parseServerMessage(
      JSON.stringify({
        type: 'SIGNAL',
        senderId: 'host',
        targetId: 'client-123',
        sdp: { type: 'answer', sdp: 'v=0\r\n' },
      }),
    );
    expect(withSdp).toEqual({
      type: 'SIGNAL',
      senderId: 'host',
      targetId: 'client-123',
      sdp: { type: 'answer', sdp: 'v=0\r\n' },
    });

    const withCandidate = parseServerMessage(
      JSON.stringify({
        type: 'SIGNAL',
        senderId: 'host',
        targetId: 'client-123',
        candidate: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );
    expect(withCandidate).toEqual({
      type: 'SIGNAL',
      senderId: 'host',
      targetId: 'client-123',
      candidate: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
  });

  it('parses KICKED, ROOM_CLOSED, and ERROR messages', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'KICKED', roomId: 'K7M2PX', reason: 'Removed by host' }),
      ),
    ).toEqual({ type: 'KICKED', roomId: 'K7M2PX', reason: 'Removed by host' });

    expect(
      parseServerMessage(
        JSON.stringify({ type: 'ROOM_CLOSED', roomId: 'K7M2PX', reason: 'Host disconnected' }),
      ),
    ).toEqual({ type: 'ROOM_CLOSED', roomId: 'K7M2PX', reason: 'Host disconnected' });

    expect(
      parseServerMessage(
        JSON.stringify({ type: 'ERROR', code: 'ROOM_NOT_FOUND', message: 'Not found' }),
      ),
    ).toEqual({ type: 'ERROR', code: 'ROOM_NOT_FOUND', message: 'Not found' });
  });

  it('rejects malformed or unknown server messages', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'UNKNOWN' }))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ type: 'SIGNAL', senderId: 'host', targetId: 'c1' })),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'SIGNAL', senderId: 'host', targetId: 'c1', sdp: { type: 'bogus' } }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ type: 'ERROR', code: 'BAD_CODE', message: 'x' })),
    ).toBeNull();
  });

  it('parses DataChannel HOST_MUTE and SELF_MUTE control messages', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'HOST_MUTE', muted: true }))).toEqual({
      type: 'HOST_MUTE',
      muted: true,
    });
    expect(parseControlMessage(JSON.stringify({ type: 'SELF_MUTE', muted: false }))).toEqual({
      type: 'SELF_MUTE',
      muted: false,
    });
    expect(parseControlMessage(JSON.stringify({ type: 'HOST_MUTE', muted: 'yes' }))).toBeNull();
    expect(parseControlMessage('{broken')).toBeNull();
  });
});
