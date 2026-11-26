import { describe, expect, it } from 'vitest';
import {
  VOCAL_AUDIO_CONSTRAINTS,
  normalizeRoomId,
  parseLaunchParams,
  resolveSignalingUrl,
  validateClientName,
  validateRoomId,
} from '../src/config';

describe('config helpers', () => {
  it('exposes low-latency vocal audio constraints matching KaroSync spec', () => {
    expect(VOCAL_AUDIO_CONSTRAINTS).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0.01,
    });
  });

  it('normalizes and validates room IDs', () => {
    expect(normalizeRoomId(' k7m-2px! ')).toBe('K7M2PX');
    expect(normalizeRoomId('abcdefgh')).toBe('ABCDEF');
    expect(validateRoomId('K7M2PX')).toBeNull();
    expect(validateRoomId('')).toContain('Masukkan kode Room');
    expect(validateRoomId('ABC')).toContain('6 karakter');
  });

  it('validates singer names within 1..32 characters', () => {
    expect(validateClientName('Budi')).toBeNull();
    expect(validateClientName('   ')).toContain('Nama Penyanyi');
    expect(validateClientName('A'.repeat(33))).toContain('32 karakter');
  });

  it('parses ?room= and ?ws= query parameters', () => {
    expect(parseLaunchParams('?room=k7m2px&ws=wss://sig.karosync.app')).toEqual({
      roomId: 'K7M2PX',
      fromQuery: true,
      querySignalingUrl: 'wss://sig.karosync.app',
    });

    expect(parseLaunchParams('?ws=http://invalid-scheme')).toEqual({
      roomId: '',
      fromQuery: false,
      querySignalingUrl: null,
    });
  });

  it('resolves signaling URL by priority: queryWs > overrideWs > envWs > location default', () => {
    expect(
      resolveSignalingUrl({
        queryWs: 'wss://query.example.com',
        overrideWs: 'wss://override.example.com',
        envWs: 'wss://env.example.com',
        location: { protocol: 'https:', hostname: 'mic.example.com' },
      }),
    ).toBe('wss://query.example.com');

    expect(
      resolveSignalingUrl({
        overrideWs: 'ws://192.168.1.9:8080',
        envWs: 'wss://env.example.com',
        location: { protocol: 'http:', hostname: 'localhost' },
      }),
    ).toBe('ws://192.168.1.9:8080');

    expect(
      resolveSignalingUrl({
        envWs: 'wss://env.example.com',
        location: { protocol: 'https:', hostname: 'mic.example.com' },
      }),
    ).toBe('wss://env.example.com');

    expect(
      resolveSignalingUrl({
        location: { protocol: 'http:', hostname: '192.168.1.50' },
      }),
    ).toBe('ws://192.168.1.50:8080');

    expect(
      resolveSignalingUrl({
        location: { protocol: 'https:', hostname: 'stage.example.com' },
      }),
    ).toBe('wss://stage.example.com:8080');
  });
});
