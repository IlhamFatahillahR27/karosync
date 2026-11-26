export interface AudioParamLike {
  value: number;
  setTargetAtTime?: (target: number, startTime: number, timeConstant: number) => void;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number;
  smoothingTimeConstant: number;
  readonly frequencyBinCount: number;
  getFloatTimeDomainData?: (array: Float32Array<ArrayBuffer>) => void;
  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
  readonly reduction: number;
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createGain(): GainNodeLike;
  createAnalyser(): AnalyserNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface HiddenAudioElementLike {
  muted: boolean;
  autoplay: boolean;
  srcObject: MediaStream | null;
  play(): Promise<void>;
  pause(): void;
}

export interface PeerLevelMetrics {
  rms: number;
  peak: number;
  normalized: number;
}

export interface MixerSampleSnapshot {
  levels: Map<string, PeerLevelMetrics>;
  maxActiveRms: number;
  compressorReductionDb: number;
}

export interface AudioMixerOptions {
  audioContextFactory?: () => AudioContextLike;
  audioElementFactory?: () => HiddenAudioElementLike;
  onStateChange?: (state: AudioContextState) => void;
}

interface PeerChannel {
  clientId: string;
  source: AudioNodeLike;
  gainNode: GainNodeLike;
  analyser: AnalyserNodeLike;
  floatBuffer: Float32Array<ArrayBuffer>;
  byteBuffer: Uint8Array<ArrayBuffer>;
  sinkElement: HiddenAudioElementLike | null;
}

interface PeerGainSetting {
  volume: number;
  muted: boolean;
}

export const MIN_GAIN = 0;
export const MAX_GAIN = 1.5;
const RAMP_TIME_CONSTANT_SEC = 0.015;

function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, value));
}

function setSmoothParam(param: AudioParamLike, value: number, currentTime: number): void {
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, currentTime, RAMP_TIME_CONSTANT_SEC);
  } else {
    param.value = value;
  }
}

function defaultAudioContextFactory(): AudioContextLike {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API tidak didukung di browser ini.');
  }
  return new Ctor({ latencyHint: 'interactive' }) as unknown as AudioContextLike;
}

function defaultAudioElementFactory(): HiddenAudioElementLike {
  const el = document.createElement('audio');
  el.muted = true;
  el.autoplay = true;
  el.setAttribute('playsinline', '');
  return el as unknown as HiddenAudioElementLike;
}

export class AudioMixer {
  private readonly audioContextFactory: () => AudioContextLike;
  private readonly audioElementFactory: () => HiddenAudioElementLike;
  private readonly onStateChange?: (state: AudioContextState) => void;

  private ctx: AudioContextLike | null = null;
  private masterGain: GainNodeLike | null = null;
  private compressor: DynamicsCompressorNodeLike | null = null;
  private masterVolume = 1;

  private readonly channels = new Map<string, PeerChannel>();
  private readonly peerSettings = new Map<string, PeerGainSetting>();

  constructor(options: AudioMixerOptions = {}) {
    this.audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory;
    this.audioElementFactory = options.audioElementFactory ?? defaultAudioElementFactory;
    this.onStateChange = options.onStateChange;
  }

  public getContextState(): AudioContextState {
    return this.ctx?.state ?? 'suspended';
  }

  public ensureInitialized(): AudioContextLike {
    if (this.ctx) {
      return this.ctx;
    }

    const ctx = this.audioContextFactory();
    const masterGain = ctx.createGain();
    masterGain.gain.value = this.masterVolume;

    const compressor = ctx.createDynamicsCompressor();
    // Karaoke vocal safety limiter/compressor to prevent TV/HDMI speaker clipping
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    this.ctx = ctx;
    this.masterGain = masterGain;
    this.compressor = compressor;
    this.onStateChange?.(ctx.state);
    return ctx;
  }

  public async ensureRunning(): Promise<AudioContextState> {
    const ctx = this.ensureInitialized();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Browser may still require an explicit user gesture
      }
    }
    this.onStateChange?.(ctx.state);
    return ctx.state;
  }

  public attachStream(clientId: string, stream: MediaStream): void {
    const ctx = this.ensureInitialized();
    if (!this.masterGain) {
      return;
    }

    this.disconnectChannelOnly(clientId);

    // Chromium workaround (bug 933677): attach remote WebRTC stream to a muted <audio> sink
    // so the browser actively decodes incoming audio frames for Web Audio API nodes.
    let sinkElement: HiddenAudioElementLike | null = null;
    try {
      sinkElement = this.audioElementFactory();
      sinkElement.muted = true;
      sinkElement.autoplay = true;
      sinkElement.srcObject = stream;
      void sinkElement.play().catch(() => {
        // Ignore autoplay rejection on muted sink
      });
    } catch {
      sinkElement = null;
    }

    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;

    const setting = this.getOrCreateSetting(clientId);
    gainNode.gain.value = setting.muted ? 0 : setting.volume;

    source.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(this.masterGain);

    this.channels.set(clientId, {
      clientId,
      source,
      gainNode,
      analyser,
      floatBuffer: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
      byteBuffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      sinkElement,
    });

    if (ctx.state === 'suspended') {
      void this.ensureRunning();
    }
  }

  public setPeerVolume(clientId: string, volume: number): void {
    const clamped = clampGain(volume);
    const setting = this.getOrCreateSetting(clientId);
    setting.volume = clamped;

    const channel = this.channels.get(clientId);
    if (channel && this.ctx) {
      const effective = setting.muted ? 0 : setting.volume;
      setSmoothParam(channel.gainNode.gain, effective, this.ctx.currentTime);
    }
  }

  public setPeerMuted(clientId: string, muted: boolean): void {
    const setting = this.getOrCreateSetting(clientId);
    setting.muted = muted;

    const channel = this.channels.get(clientId);
    if (channel && this.ctx) {
      const effective = setting.muted ? 0 : setting.volume;
      setSmoothParam(channel.gainNode.gain, effective, this.ctx.currentTime);
    }
  }

  public setMasterVolume(volume: number): void {
    this.masterVolume = clampGain(volume);
    if (this.masterGain && this.ctx) {
      setSmoothParam(this.masterGain.gain, this.masterVolume, this.ctx.currentTime);
    }
  }

  public getMasterVolume(): number {
    return this.masterVolume;
  }

  public hasChannel(clientId: string): boolean {
    return this.channels.has(clientId);
  }

  public sampleLevels(): MixerSampleSnapshot {
    const levels = new Map<string, PeerLevelMetrics>();
    let maxActiveRms = 0;

    for (const [clientId, channel] of this.channels.entries()) {
      const setting = this.peerSettings.get(clientId);
      const isMuted = setting?.muted ?? false;

      if (isMuted) {
        levels.set(clientId, { rms: 0, peak: 0, normalized: 0 });
        continue;
      }

      const { rms, peak } = this.readAnalyserMetrics(channel);
      const normalized = Math.min(1, Math.pow(rms * 3.8, 0.85));
      levels.set(clientId, { rms, peak, normalized });

      if (rms > maxActiveRms) {
        maxActiveRms = rms;
      }
    }

    const compressorReductionDb =
      this.compressor && Number.isFinite(this.compressor.reduction)
        ? this.compressor.reduction
        : 0;

    return {
      levels,
      maxActiveRms,
      compressorReductionDb,
    };
  }

  public removePeer(clientId: string): void {
    this.disconnectChannelOnly(clientId);
    this.peerSettings.delete(clientId);
  }

  public async dispose(): Promise<void> {
    for (const clientId of Array.from(this.channels.keys())) {
      this.disconnectChannelOnly(clientId);
    }
    this.peerSettings.clear();

    try {
      this.masterGain?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    try {
      this.compressor?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.masterGain = null;
    this.compressor = null;

    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      try {
        await ctx.close();
      } catch {
        // Ignore close errors
      }
    }
    this.onStateChange?.('closed');
  }

  private getOrCreateSetting(clientId: string): PeerGainSetting {
    let setting = this.peerSettings.get(clientId);
    if (!setting) {
      setting = { volume: 1, muted: false };
      this.peerSettings.set(clientId, setting);
    }
    return setting;
  }

  private disconnectChannelOnly(clientId: string): void {
    const existing = this.channels.get(clientId);
    if (!existing) {
      return;
    }
    this.channels.delete(clientId);

    try {
      existing.source.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    try {
      existing.gainNode.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    try {
      existing.analyser.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    if (existing.sinkElement) {
      try {
        existing.sinkElement.pause();
        existing.sinkElement.srcObject = null;
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private readAnalyserMetrics(channel: PeerChannel): { rms: number; peak: number } {
    let sumSquares = 0;
    let peak = 0;

    if (typeof channel.analyser.getFloatTimeDomainData === 'function') {
      channel.analyser.getFloatTimeDomainData(channel.floatBuffer);
      const len = channel.floatBuffer.length;
      for (let i = 0; i < len; i += 1) {
        const sample = channel.floatBuffer[i] ?? 0;
        const abs = Math.abs(sample);
        if (abs > peak) {
          peak = abs;
        }
        sumSquares += sample * sample;
      }
      return {
        rms: len > 0 ? Math.sqrt(sumSquares / len) : 0,
        peak,
      };
    }

    channel.analyser.getByteTimeDomainData(channel.byteBuffer);
    const len = channel.byteBuffer.length;
    for (let i = 0; i < len; i += 1) {
      const sample = ((channel.byteBuffer[i] ?? 128) - 128) / 128;
      const abs = Math.abs(sample);
      if (abs > peak) {
        peak = abs;
      }
      sumSquares += sample * sample;
    }
    return {
      rms: len > 0 ? Math.sqrt(sumSquares / len) : 0,
      peak,
    };
  }
}
