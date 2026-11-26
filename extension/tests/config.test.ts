import { describe, expect, it } from 'vitest';
import {
  buildMicJoinUrl,
  isValidHttpUrl,
  isValidWebSocketUrl,
} from '../src/config';

describe('extension config helpers', () => {
  it('validates WebSocket and HTTP URLs strictly', () => {
    expect(isValidWebSocketUrl('ws://localhost:8080')).toBe(true);
    expect(isValidWebSocketUrl('wss://sig.karosync.app')).toBe(true);
    expect(isValidWebSocketUrl('https://sig.karosync.app')).toBe(false);
    expect(isValidWebSocketUrl('invalid')).toBe(false);

    expect(isValidHttpUrl('http://localhost:5173')).toBe(true);
    expect(isValidHttpUrl('https://mic.karosync.app')).toBe(true);
    expect(isValidHttpUrl('ws://localhost:8080')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });

  it('builds Mic join URL with room and optional ws parameter', () => {
    const withWs = buildMicJoinUrl({
      clientBaseUrl: 'https://mic.karosync.app',
      roomId: 'k7m2px',
      signalingUrl: 'wss://sig.karosync.app',
      includeWsInQr: true,
    });
    const parsedWithWs = new URL(withWs);
    expect(parsedWithWs.origin).toBe('https://mic.karosync.app');
    expect(parsedWithWs.searchParams.get('room')).toBe('K7M2PX');
    expect(parsedWithWs.searchParams.get('ws')).toBe('wss://sig.karosync.app');

    const withoutWs = buildMicJoinUrl({
      clientBaseUrl: 'https://mic.karosync.app/?ws=ws://old',
      roomId: 'K7M2PX',
      signalingUrl: 'wss://sig.karosync.app',
      includeWsInQr: false,
    });
    const parsedWithoutWs = new URL(withoutWs);
    expect(parsedWithoutWs.searchParams.get('room')).toBe('K7M2PX');
    expect(parsedWithoutWs.searchParams.get('ws')).toBeNull();
  });
});
