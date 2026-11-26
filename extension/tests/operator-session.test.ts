import { describe, expect, it, vi } from 'vitest';
import type { HostSignalingOptions } from '../src/host-signaling';
import {
  OperatorSession,
  type AudioMixerLike,
  type HostSignalingLike,
  type WebRtcReceiverLike,
  type YouTubeControllerLike,
} from '../src/operator-session';
import type { WebRtcReceiverManagerOptions } from '../src/webrtc-receiver';

describe('OperatorSession', () => {
  it('orchestrates room creation, peer mute/kick, and YouTube volume with Quick Ducking', async () => {
    let signalingOpts: HostSignalingOptions | null = null;
    let webrtcOpts: WebRtcReceiverManagerOptions | null = null;

    const fakeSignaling: HostSignalingLike = {
      connect: vi.fn(),
      sendSignal: vi.fn(() => true),
      kickClient: vi.fn(() => true),
      disconnect: vi.fn(),
    };

    const fakeWebRtc: WebRtcReceiverLike = {
      ensurePeer: vi.fn(),
      handleIncomingSignal: vi.fn(async () => undefined),
      setHostMute: vi.fn(),
      removePeer: vi.fn(),
      closeAll: vi.fn(),
    };

    let currentRms = 0;
    let currentCompressor = {
      threshold: -18,
      knee: 12,
      ratio: 8,
      attack: 0.003,
      release: 0.15,
    };
    const fakeMixer: AudioMixerLike = {
      getContextState: () => 'running',
      ensureRunning: vi.fn(async () => 'running' as AudioContextState),
      attachStream: vi.fn(),
      setPeerVolume: vi.fn(),
      setPeerMuted: vi.fn(),
      setMasterVolume: vi.fn(),
      getCompressorSettings: () => ({ ...currentCompressor }),
      setCompressorSettings: vi.fn((partial) => {
        currentCompressor = { ...currentCompressor, ...partial };
        return { ...currentCompressor };
      }),
      getOutputLatencyMs: () => 18,
      sampleLevels: () => ({
        levels: new Map([['c1', { rms: currentRms, peak: currentRms, normalized: currentRms }]]),
        maxActiveRms: currentRms,
        compressorReductionDb: 0,
      }),
      removePeer: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };

    const fakeYouTube: YouTubeControllerLike = {
      getStatus: vi.fn(async () => ({
        found: true,
        volume: 0.8,
        muted: false,
        paused: false,
        title: 'Bohemian Rhapsody Karaoke',
        url: 'https://www.youtube.com/watch?v=123',
      })),
      setVolume: vi.fn(async (volume: number) => ({
        ok: true,
        found: true,
        volume,
        muted: volume === 0,
        paused: false,
        title: 'Bohemian Rhapsody Karaoke',
        url: 'https://www.youtube.com/watch?v=123',
      })),
    };

    const session = new OperatorSession({
      initialSettings: {
        signalingUrl: 'ws://localhost:8080',
        clientBaseUrl: 'https://mic.karosync.app',
        includeWsInQr: true,
      },
      initialDuckingEnabled: true,
      youtubePollIntervalMs: 0,
      createSignalingClient: (opts) => {
        signalingOpts = opts;
        return fakeSignaling;
      },
      createWebRtcManager: (opts) => {
        webrtcOpts = opts;
        return fakeWebRtc;
      },
      audioMixer: fakeMixer,
      youtubeController: fakeYouTube,
    });

    expect(session.getState().roomStatus).toBe('idle');
    expect(session.getState().roomId).toBeNull();
    expect(session.getState().compressorPreset).toBe('balanced');
    expect(session.getState().compressor.threshold).toBe(-18);
    expect(session.getState().audioLatencyMs).toBe(18);

    // Tune vocal limiter preset & custom threshold
    session.setCompressorPreset('tv_safe');
    expect(session.getState().compressorPreset).toBe('tv_safe');
    expect(session.getState().compressor.threshold).toBe(-22);
    expect(session.getState().compressor.ratio).toBe(12);

    session.setCompressorThreshold(-26);
    expect(session.getState().compressorPreset).toBe('custom');
    expect(session.getState().compressor.threshold).toBe(-26);

    session.startRoom();
    signalingOpts!.callbacks.onRoomCreated({ type: 'ROOM_CREATED', roomId: 'K7M2PX' });
    await Promise.resolve();
    expect(session.getState().roomStatus).toBe('live');
    expect(session.getState().joinUrl).toContain('room=K7M2PX');
    expect(session.getState().youtube.connected).toBe(true);
    expect(session.getState().youtube.targetVolume).toBe(0.8);

    // Client joins and connects stream
    signalingOpts!.callbacks.onClientJoined({
      type: 'CLIENT_JOINED',
      roomId: 'K7M2PX',
      clientId: 'c1',
      clientName: 'Siti',
    });
    expect(session.getState().peers).toHaveLength(1);
    expect(fakeWebRtc.ensurePeer).toHaveBeenCalledWith('c1');

    const stream = { id: 's1' } as unknown as MediaStream;
    webrtcOpts!.callbacks.onStream('c1', stream);
    expect(fakeMixer.attachStream).toHaveBeenCalledWith('c1', stream);

    // Speech triggers Quick Ducking -> drops YouTube volume to 0.3
    currentRms = 0.15;
    session.sampleMeters(1000);
    expect(session.getState().youtube.isDucked).toBe(true);
    expect(fakeYouTube.setVolume).toHaveBeenCalledWith(0.3);

    // Host mute -> mutes mixer + notifies client via DataChannel
    session.togglePeerHostMute('c1');
    expect(fakeMixer.setPeerMuted).toHaveBeenCalledWith('c1', true);
    expect(fakeWebRtc.setHostMute).toHaveBeenCalledWith('c1', true);
    expect(session.getState().peers[0]!.hostMuted).toBe(true);

    // Kick peer -> sends KICK_CLIENT and cleans up peer & restores ducking
    session.kickPeer('c1');
    expect(fakeSignaling.kickClient).toHaveBeenCalledWith('c1', expect.any(String));
    expect(fakeWebRtc.removePeer).toHaveBeenCalledWith('c1');
    expect(fakeMixer.removePeer).toHaveBeenCalledWith('c1');
    expect(session.getState().peers).toHaveLength(0);
    expect(session.getState().youtube.isDucked).toBe(false);

    // Exit room -> disconnects signaling, clears roomId, returns to idle lobby
    session.stopRoom();
    expect(fakeSignaling.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeWebRtc.closeAll).toHaveBeenCalledTimes(1);
    expect(session.getState().roomStatus).toBe('idle');
    expect(session.getState().roomId).toBeNull();
    expect(session.getState().joinUrl).toBeNull();

    await session.dispose();
    expect(fakeMixer.dispose).toHaveBeenCalledTimes(1);
  });
});
