import {
  DEFAULT_AUDIO_CAPTURE_MODE,
  getAudioConstraintsForMode,
  type AudioCaptureMode,
} from './config';

export interface AudioLevels {
  rms: number;
  peak: number;
  clipping: boolean;
}

export interface AudioCaptureCallbacks {
  mode?: AudioCaptureMode;
  onTrackEnded?: () => void;
}

type AudioContextConstructor = typeof AudioContext;

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: AudioContextConstructor;
}

export function formatMicrophoneError(error: unknown): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Akses mikrofon membutuhkan koneksi HTTPS (atau localhost). Gunakan tunnel HTTPS / domain produksi saat membuka dari HP.';
  }

  if (error instanceof DOMException || error instanceof Error) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Izin mikrofon ditolak. Aktifkan izin mikrofon di pengaturan browser lalu coba lagi.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Mikrofon tidak ditemukan pada perangkat ini.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Mikrofon sedang digunakan oleh aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.';
      case 'OverconstrainedError':
        return 'Perangkat tidak mendukung konfigurasi audio yang diminta.';
      case 'SecurityError':
        return 'Akses mikrofon diblokir oleh kebijakan keamanan browser (pastikan menggunakan HTTPS).';
      default:
        return error.message || 'Gagal mengakses mikrofon perangkat.';
    }
  }

  return 'Gagal mengakses mikrofon perangkat.';
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private timeDomainData: Uint8Array<ArrayBuffer> | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private muted = false;
  private trackEndedHandler: (() => void) | null = null;

  public async start(callbacks: AudioCaptureCallbacks = {}): Promise<MediaStream> {
    this.stop();

    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new Error(
        typeof window !== 'undefined' && !window.isSecureContext
          ? 'Akses mikrofon membutuhkan HTTPS (atau localhost).'
          : 'Browser ini tidak mendukung akses mikrofon (getUserMedia).',
      );
    }

    const { primary, fallback } = getAudioConstraintsForMode(
      callbacks.mode ?? DEFAULT_AUDIO_CAPTURE_MODE,
    );

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: primary,
        video: false,
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : '';
      if (errorName === 'OverconstrainedError' || errorName === 'TypeError') {
        stream = await mediaDevices.getUserMedia({
          audio: fallback,
          video: false,
        });
      } else {
        throw new Error(formatMicrophoneError(error));
      }
    }

    const audioTrack = stream.getAudioTracks()[0] ?? null;
    if (!audioTrack) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      throw new Error('Stream mikrofon tidak memiliki audio track aktif.');
    }

    this.stream = stream;
    this.audioTrack = audioTrack;
    this.muted = false;
    audioTrack.enabled = true;

    if (callbacks.onTrackEnded) {
      const onEnded = () => {
        callbacks.onTrackEnded?.();
      };
      this.trackEndedHandler = onEnded;
      audioTrack.addEventListener('ended', onEnded, { once: true });
    }

    await this.setupAnalyser(stream);
    return stream;
  }

  public setMuted(muted: boolean): boolean {
    this.muted = muted;
    if (this.audioTrack) {
      this.audioTrack.enabled = !muted;
    }
    return this.muted;
  }

  public toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getStream(): MediaStream | null {
    return this.stream;
  }

  public getAudioTrack(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  public sampleAudio(): {
    levels: AudioLevels;
    frequencyBins: Uint8Array<ArrayBuffer> | null;
  } {
    if (!this.analyserNode || !this.timeDomainData || !this.frequencyData || this.muted) {
      return {
        levels: { rms: 0, peak: 0, clipping: false },
        frequencyBins: null,
      };
    }

    this.analyserNode.getByteTimeDomainData(this.timeDomainData);
    this.analyserNode.getByteFrequencyData(this.frequencyData);

    let sumSquares = 0;
    let peak = 0;
    const len = this.timeDomainData.length;

    for (let i = 0; i < len; i += 1) {
      const sampleByte = this.timeDomainData[i] ?? 128;
      const normalized = (sampleByte - 128) / 128;
      const abs = Math.abs(normalized);
      if (abs > peak) {
        peak = abs;
      }
      sumSquares += normalized * normalized;
    }

    const rms = len > 0 ? Math.sqrt(sumSquares / len) : 0;
    return {
      levels: {
        rms: Math.min(1, rms * 1.8),
        peak: Math.min(1, peak),
        clipping: peak >= 0.94,
      },
      frequencyBins: this.frequencyData,
    };
  }

  public stop(): void {
    if (this.audioTrack && this.trackEndedHandler) {
      this.audioTrack.removeEventListener('ended', this.trackEndedHandler);
    }
    this.trackEndedHandler = null;

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.sourceNode = null;
    }

    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.analyserNode = null;
    }

    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      void ctx.close().catch(() => {
        // Ignore close errors
      });
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }

    this.audioTrack = null;
    this.timeDomainData = null;
    this.frequencyData = null;
    this.muted = false;
  }

  private async setupAnalyser(stream: MediaStream): Promise<void> {
    const AudioCtx =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as WindowWithWebkitAudioContext).webkitAudioContext)
        : undefined;

    if (!AudioCtx) {
      return;
    }

    const audioContext = new AudioCtx({ latencyHint: 'interactive' });
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch {
        // Non-fatal: visualizer may resume on next interaction
      }
    }

    // Intentionally NOT connected to audioContext.destination to prevent local speaker feedback
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.72;
    sourceNode.connect(analyserNode);

    this.audioContext = audioContext;
    this.sourceNode = sourceNode;
    this.analyserNode = analyserNode;
    this.timeDomainData = new Uint8Array(new ArrayBuffer(analyserNode.fftSize));
    this.frequencyData = new Uint8Array(new ArrayBuffer(analyserNode.frequencyBinCount));
  }
}
