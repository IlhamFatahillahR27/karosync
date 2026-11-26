import { describe, expect, it, vi } from 'vitest';
import {
  MicSession,
  type AudioCaptureLike,
  type SignalingClientLike,
  type WakeLockControllerLike,
  type WebRtcSenderLike,
} from '../src/mic-session';
import type { SignalingClientOptions } from '../src/signaling-client';
import type { WakeLockState } from '../src/wake-lock';
import type { WebRtcSenderOptions } from '../src/webrtc-sender';

function createHarness() {
  let muted = false;
  let wakeLockState: WakeLockState = 'inactive';
  let wakeLockListener: ((state: WakeLockState) => void) | null = null;
  let lastSignalingOptions: SignalingClientOptions | null = null;
  let lastWebRtcOptions: WebRtcSenderOptions | null = null;

  const audioCapture: AudioCaptureLike = {
    start: vi.fn(async () => ({ getAudioTracks: () => [] }) as unknown as MediaStream),
    setMuted: vi.fn((next: boolean) => {
      muted = next;
      return muted;
    }),
    toggleMute: vi.fn(() => {
      muted = !muted;
      return muted;
    }),
    isMuted: () => muted,
    getStream: () => null,
    sampleAudio: () => ({ levels: { rms: 0, peak: 0, clipping: false }, frequencyBins: null }),
    stop: vi.fn(),
  };

  const signalingMock: SignalingClientLike = {
    connect: vi.fn(),
    sendSignal: vi.fn(() => true),
    disconnect: vi.fn(),
  };

  const webrtcMock: WebRtcSenderLike = {
    startOffer: vi.fn(async () => {}),
    handleIncomingSignal: vi.fn(async () => {}),
    sendSelfMute: vi.fn(),
    close: vi.fn(),
  };

  const wakeLockMock: WakeLockControllerLike = {
    getState: () => wakeLockState,
    acquire: vi.fn(async (): Promise<WakeLockState> => {
      wakeLockState = 'active';
      wakeLockListener?.('active');
      return 'active';
    }),
    release: vi.fn(async () => {
      wakeLockState = 'inactive';
      wakeLockListener?.('inactive');
    }),
  };

  const session = new MicSession(
    { roomId: 'K7M2PX', clientName: 'Budi', signalingUrl: 'ws://localhost:8080' },
    {
      audioCapture,
      createSignalingClient: (opts) => {
        lastSignalingOptions = opts;
        return signalingMock;
      },
      createWebRtcSender: (opts) => {
        lastWebRtcOptions = opts;
        return webrtcMock;
      },
      createWakeLockController: (onStateChange) => {
        wakeLockListener = onStateChange;
        return wakeLockMock;
      },
    },
  );

  return {
    session,
    audioCapture,
    signalingMock,
    webrtcMock,
    wakeLockMock,
    getSignalingCallbacks: () => lastSignalingOptions!.callbacks,
    getWebRtcCallbacks: () => lastWebRtcOptions!.callbacks,
  };
}

describe('MicSession state machine', () => {
  it('validates room ID and singer name before requesting microphone', async () => {
    const { session, audioCapture } = createHarness();

    await session.connect({
      roomId: 'AB',
      clientName: 'Budi',
      signalingUrl: 'ws://localhost:8080',
    });
    expect(session.getState().status).toBe('disconnected');
    expect(session.getState().error).toContain('6 karakter');
    expect(audioCapture.start).not.toHaveBeenCalled();

    await session.connect({
      roomId: 'K7M2PX',
      clientName: '   ',
      signalingUrl: 'ws://localhost:8080',
    });
    expect(session.getState().error).toContain('Nama Penyanyi');
    expect(audioCapture.start).not.toHaveBeenCalled();
  });

  it('transitions disconnected -> connecting -> live -> muted_by_host -> live -> disconnected', async () => {
    const {
      session,
      audioCapture,
      signalingMock,
      webrtcMock,
      wakeLockMock,
      getSignalingCallbacks,
      getWebRtcCallbacks,
    } = createHarness();

    await session.connect({
      roomId: 'k7m2px',
      clientName: 'Budi',
      signalingUrl: 'ws://localhost:8080',
    });

    expect(session.getState().status).toBe('connecting');
    expect(session.getState().wakeLockState).toBe('active');
    expect(signalingMock.connect).toHaveBeenCalledTimes(1);

    // Server confirms room joined -> starts WebRTC offer
    getSignalingCallbacks().onJoined({
      type: 'ROOM_JOINED',
      roomId: 'K7M2PX',
      clientId: 'client-1',
      clientName: 'Budi',
    });
    expect(webrtcMock.startOffer).toHaveBeenCalledTimes(1);

    // WebRTC P2P connects -> Live on Air
    getWebRtcCallbacks().onConnectionStateChange('connected');
    expect(session.getState().status).toBe('live');

    // Local self-mute toggle updates audio track and sends DataChannel SELF_MUTE
    session.toggleSelfMute();
    expect(session.getState().selfMuted).toBe(true);
    expect(webrtcMock.sendSelfMute).toHaveBeenCalledWith(true);

    // Host mutes client -> Muted by Host
    getWebRtcCallbacks().onHostMuteChange(true);
    expect(session.getState().status).toBe('muted_by_host');
    expect(session.getState().hostMuted).toBe(true);

    // Host unmutes client -> back to Live on Air
    getWebRtcCallbacks().onHostMuteChange(false);
    expect(session.getState().status).toBe('live');
    expect(session.getState().hostMuted).toBe(false);

    // Manual disconnect tears down all resources
    session.disconnect();
    expect(session.getState().status).toBe('disconnected');
    expect(webrtcMock.close).toHaveBeenCalledTimes(1);
    expect(signalingMock.disconnect).toHaveBeenCalledTimes(1);
    expect(audioCapture.stop).toHaveBeenCalled();
    expect(wakeLockMock.release).toHaveBeenCalled();
  });

  it('handles KICKED and ROOM_CLOSED cleanly with full cleanup', async () => {
    const { session, audioCapture, webrtcMock, wakeLockMock, getSignalingCallbacks } =
      createHarness();

    await session.connect({
      roomId: 'K7M2PX',
      clientName: 'Budi',
      signalingUrl: 'ws://localhost:8080',
    });

    getSignalingCallbacks().onJoined({
      type: 'ROOM_JOINED',
      roomId: 'K7M2PX',
      clientId: 'client-1',
      clientName: 'Budi',
    });

    getSignalingCallbacks().onKicked({
      type: 'KICKED',
      roomId: 'K7M2PX',
      reason: 'Feedback terlalu keras',
    });

    expect(session.getState().status).toBe('disconnected');
    expect(session.getState().error).toContain('Feedback terlalu keras');
    expect(webrtcMock.close).toHaveBeenCalledTimes(1);
    expect(audioCapture.stop).toHaveBeenCalled();
    expect(wakeLockMock.release).toHaveBeenCalled();

    // Connect again and test ROOM_CLOSED
    await session.connect({
      roomId: 'K7M2PX',
      clientName: 'Budi',
      signalingUrl: 'ws://localhost:8080',
    });
    getSignalingCallbacks().onRoomClosed({
      type: 'ROOM_CLOSED',
      roomId: 'K7M2PX',
      reason: 'Host disconnected',
    });
    expect(session.getState().status).toBe('disconnected');
    expect(session.getState().error).toContain('Host disconnected');
  });

  it('returns to disconnected with error if getUserMedia fails', async () => {
    const { session, audioCapture, signalingMock } = createHarness();
    vi.mocked(audioCapture.start).mockRejectedValueOnce(new Error('Izin mikrofon ditolak.'));

    await session.connect({
      roomId: 'K7M2PX',
      clientName: 'Budi',
      signalingUrl: 'ws://localhost:8080',
    });

    expect(session.getState().status).toBe('disconnected');
    expect(session.getState().error).toBe('Izin mikrofon ditolak.');
    expect(signalingMock.connect).not.toHaveBeenCalled();
  });
});
