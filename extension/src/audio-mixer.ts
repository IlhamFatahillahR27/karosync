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

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: AudioNodeLike;
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createGain(): GainNodeLike;
  createAnalyser(): AnalyserNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createBiquadFilter?: () => BiquadFilterNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export type BuiltInCompressorPresetId = 'tv_safe' | 'balanced' | 'stage';
export type CompressorPresetId = BuiltInCompressorPresetId | 'custom';

export interface CompressorSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

export const MIN_COMPRESSOR_THRESHOLD_DB = -36;
export const MAX_COMPRESSOR_THRESHOLD_DB = -6;

export const COMPRESSOR_PRESETS: Record<BuiltInCompressorPresetId, CompressorSettings> = {
  tv_safe: {
    threshold: -22,
    knee: 10,
    ratio: 12,
    attack: 0.002,
    release: 0.18,
  },
  balanced: {
    threshold: -18,
    knee: 12,
    ratio: 8,
    attack: 0.003,
    release: 0.15,
  },
  stage: {
    threshold: -12,
    knee: 18,
    ratio: 6,
    attack: 0.005,
    release: 0.12,
  },
};

export const DEFAULT_COMPRESSOR_PRESET: BuiltInCompressorPresetId = 'balanced';
export const DEFAULT_COMPRESSOR_SETTINGS: CompressorSettings = {
  ...COMPRESSOR_PRESETS[DEFAULT_COMPRESSOR_PRESET],
};

export interface AntiFeedbackDspSettings {
  highPassEnabled: boolean;
  highPassFrequencyHz: number;
  noiseGateEnabled: boolean;
  noiseGateThreshold: number;
  noiseGateHoldMs: number;
}

export const MIN_NOISE_GATE_THRESHOLD = 0.01;
export const MAX_NOISE_GATE_THRESHOLD = 0.12;
export const DEFAULT_HIGH_PASS_HZ = 120;

export const DEFAULT_ANTI_FEEDBACK_DSP: AntiFeedbackDspSettings = {
  highPassEnabled: true,
  highPassFrequencyHz: DEFAULT_HIGH_PASS_HZ,
  noiseGateEnabled: true,
  noiseGateThreshold: 0.035,
  noiseGateHoldMs: 260,
};

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
  gateOpen: boolean;
}

export interface MixerSampleSnapshot {
  levels: Map<string, PeerLevelMetrics>;
  maxActiveRms: number;
  compressorReductionDb: number;
}

export interface AudioMixerOptions {
  audioContextFactory?: () => AudioContextLike;
  audioElementFactory?: () => HiddenAudioElementLike;
  initialCompressorSettings?: Partial<CompressorSettings>;
  initialAntiFeedbackDsp?: Partial<AntiFeedbackDspSettings>;
  onStateChange?: (state: AudioContextState) => void;
}

interface PeerChannel {
  clientId: string;
  source: AudioNodeLike;
  highPassFilter: BiquadFilterNodeLike | null;
  gainNode: GainNodeLike;
  analyser: AnalyserNodeLike;
  gateGainNode: GainNodeLike;
  gateOpen: boolean;
  lastAboveGateAtMs: number;
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
const GATE_ATTACK_TIME_CONSTANT_SEC = 0.003;
const GATE_RELEASE_TIME_CONSTANT_SEC = 0.055;
const GATE_HYSTERESIS_RATIO = 0.72;

function clampRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

export function normalizeCompressorSettings(
  partial?: Partial<CompressorSettings>,
  base: CompressorSettings = DEFAULT_COMPRESSOR_SETTINGS,
): CompressorSettings {
  return {
    threshold: clampRange(partial?.threshold ?? base.threshold, -40, 0, base.threshold),
    knee: clampRange(partial?.knee ?? base.knee, 0, 40, base.knee),
    ratio: clampRange(partial?.ratio ?? base.ratio, 1, 20, base.ratio),
    attack: clampRange(partial?.attack ?? base.attack, 0, 1, base.attack),
    release: clampRange(partial?.release ?? base.release, 0, 1, base.release),
  };
}

export function normalizeAntiFeedbackDsp(
  partial?: Partial<AntiFeedbackDspSettings>,
  base: AntiFeedbackDspSettings = DEFAULT_ANTI_FEEDBACK_DSP,
): AntiFeedbackDspSettings {
  return {
    highPassEnabled:
      typeof partial?.highPassEnabled === 'boolean'
        ? partial.highPassEnabled
        : base.highPassEnabled,
    highPassFrequencyHz: clampRange(
      partial?.highPassFrequencyHz ?? base.highPassFrequencyHz,
      60,
      250,
      base.highPassFrequencyHz,
    ),
    noiseGateEnabled:
      typeof partial?.noiseGateEnabled === 'boolean'
        ? partial.noiseGateEnabled
        : base.noiseGateEnabled,
    noiseGateThreshold: clampRange(
      partial?.noiseGateThreshold ?? base.noiseGateThreshold,
      MIN_NOISE_GATE_THRESHOLD,
      MAX_NOISE_GATE_THRESHOLD,
      base.noiseGateThreshold,
    ),
    noiseGateHoldMs: clampRange(
      partial?.noiseGateHoldMs ?? base.noiseGateHoldMs,
      80,
      1000,
      base.noiseGateHoldMs,
    ),
  };
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, value));
}

function setSmoothParam(
  param: AudioParamLike,
  value: number,
  currentTime: number,
  timeConstant = RAMP_TIME_CONSTANT_SEC,
): void {
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, currentTime, timeConstant);
  } else {
    param.value = value;
  }
}

function applyHighPassFilter(
  filter: BiquadFilterNodeLike,
  dsp: AntiFeedbackDspSettings,
  currentTime: number,
): void {
  filter.type = dsp.highPassEnabled ? 'highpass' : 'allpass';
  setSmoothParam(filter.frequency, dsp.highPassFrequencyHz, currentTime);
  filter.Q.value = 0.707;
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
  private compressorSettings: CompressorSettings;
  private antiFeedbackDsp: AntiFeedbackDspSettings;
  private masterVolume = 1;

  private readonly channels = new Map<string, PeerChannel>();
  private readonly peerSettings = new Map<string, PeerGainSetting>();

  constructor(options: AudioMixerOptions = {}) {
    this.audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory;
    this.audioElementFactory = options.audioElementFactory ?? defaultAudioElementFactory;
    this.compressorSettings = normalizeCompressorSettings(options.initialCompressorSettings);
    this.antiFeedbackDsp = normalizeAntiFeedbackDsp(options.initialAntiFeedbackDsp);
    this.onStateChange = options.onStateChange;
  }

  public getContextState(): AudioContextState {
    return this.ctx?.state ?? 'suspended';
  }

  public getAntiFeedbackDsp(): AntiFeedbackDspSettings {
    return { ...this.antiFeedbackDsp };
  }

  public setAntiFeedbackDsp(partial: Partial<AntiFeedbackDspSettings>): AntiFeedbackDspSettings {
    const next = normalizeAntiFeedbackDsp(partial, this.antiFeedbackDsp);
    this.antiFeedbackDsp = next;

    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const [clientId, channel] of this.channels.entries()) {
        if (channel.highPassFilter) {
          applyHighPassFilter(channel.highPassFilter, next, now);
        }
        const setting = this.peerSettings.get(clientId);
        const isMuted = setting?.muted ?? false;
        if (!isMuted && !next.noiseGateEnabled) {
          channel.gateOpen = true;
          setSmoothParam(channel.gateGainNode.gain, 1, now, GATE_ATTACK_TIME_CONSTANT_SEC);
        }
      }
    }

    return { ...next };
  }

  public getCompressorSettings(): CompressorSettings {
    return { ...this.compressorSettings };
  }

  public setCompressorSettings(partial: Partial<CompressorSettings>): CompressorSettings {
    const next = normalizeCompressorSettings(partial, this.compressorSettings);
    this.compressorSettings = next;
    if (this.compressor && this.ctx) {
      const now = this.ctx.currentTime;
      setSmoothParam(this.compressor.threshold, next.threshold, now);
      setSmoothParam(this.compressor.knee, next.knee, now);
      setSmoothParam(this.compressor.ratio, next.ratio, now);
      setSmoothParam(this.compressor.attack, next.attack, now);
      setSmoothParam(this.compressor.release, next.release, now);
    }
    return { ...next };
  }

  public getOutputLatencyMs(): number | null {
    if (!this.ctx) {
      return null;
    }
    const base =
      typeof this.ctx.baseLatency === 'number' && Number.isFinite(this.ctx.baseLatency)
        ? this.ctx.baseLatency
        : null;
    const output =
      typeof this.ctx.outputLatency === 'number' && Number.isFinite(this.ctx.outputLatency)
        ? this.ctx.outputLatency
        : null;
    if (base === null && output === null) {
      return null;
    }
    return Math.round(((base ?? 0) + (output ?? 0)) * 1000);
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
    compressor.threshold.value = this.compressorSettings.threshold;
    compressor.knee.value = this.compressorSettings.knee;
    compressor.ratio.value = this.compressorSettings.ratio;
    compressor.attack.value = this.compressorSettings.attack;
    compressor.release.value = this.compressorSettings.release;

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
    const highPassFilter =
      typeof ctx.createBiquadFilter === 'function' ? ctx.createBiquadFilter() : null;
    const gainNode = ctx.createGain();
    const analyser = ctx.createAnalyser();
    const gateGainNode = ctx.createGain();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;

    const setting = this.getOrCreateSetting(clientId);
    gainNode.gain.value = setting.muted ? 0 : setting.volume;

    const initialGateOpen = !setting.muted && !this.antiFeedbackDsp.noiseGateEnabled;
    gateGainNode.gain.value = initialGateOpen ? 1 : 0;

    if (highPassFilter) {
      applyHighPassFilter(highPassFilter, this.antiFeedbackDsp, ctx.currentTime);
      source.connect(highPassFilter);
      highPassFilter.connect(gainNode);
    } else {
      source.connect(gainNode);
    }

    gainNode.connect(analyser);
    analyser.connect(gateGainNode);
    gateGainNode.connect(this.masterGain);

    this.channels.set(clientId, {
      clientId,
      source,
      highPassFilter,
      gainNode,
      analyser,
      gateGainNode,
      gateOpen: initialGateOpen,
      lastAboveGateAtMs: 0,
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

  public sampleLevels(nowMs = Date.now()): MixerSampleSnapshot {
    const levels = new Map<string, PeerLevelMetrics>();
    let maxActiveRms = 0;

    for (const [clientId, channel] of this.channels.entries()) {
      const setting = this.peerSettings.get(clientId);
      const isMuted = setting?.muted ?? false;

      if (isMuted) {
        channel.gateOpen = false;
        if (this.ctx) {
          setSmoothParam(channel.gateGainNode.gain, 0, this.ctx.currentTime, RAMP_TIME_CONSTANT_SEC);
        } else {
          channel.gateGainNode.gain.value = 0;
        }
        levels.set(clientId, { rms: 0, peak: 0, normalized: 0, gateOpen: false });
        continue;
      }

      const { rms, peak } = this.readAnalyserMetrics(channel);
      const normalized = Math.min(1, Math.pow(rms * 3.8, 0.85));

      if (!this.antiFeedbackDsp.noiseGateEnabled) {
        channel.gateOpen = true;
      } else {
        const openThreshold = this.antiFeedbackDsp.noiseGateThreshold;
        const closeThreshold = openThreshold * GATE_HYSTERESIS_RATIO;
        if (rms >= openThreshold) {
          channel.gateOpen = true;
          channel.lastAboveGateAtMs = nowMs;
        } else if (channel.gateOpen) {
          if (rms >= closeThreshold) {
            channel.lastAboveGateAtMs = nowMs;
          } else if (nowMs - channel.lastAboveGateAtMs >= this.antiFeedbackDsp.noiseGateHoldMs) {
            channel.gateOpen = false;
          }
        }
      }

      const gateTarget = channel.gateOpen ? 1 : 0;
      const gateRamp = channel.gateOpen
        ? GATE_ATTACK_TIME_CONSTANT_SEC
        : GATE_RELEASE_TIME_CONSTANT_SEC;
      if (this.ctx) {
        setSmoothParam(channel.gateGainNode.gain, gateTarget, this.ctx.currentTime, gateRamp);
      } else {
        channel.gateGainNode.gain.value = gateTarget;
      }

      levels.set(clientId, { rms, peak, normalized, gateOpen: channel.gateOpen });

      if (channel.gateOpen && rms > maxActiveRms) {
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
      existing.highPassFilter?.disconnect();
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
    try {
      existing.gateGainNode.disconnect();
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
