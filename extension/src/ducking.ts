export interface QuickDuckingOptions {
  duckVolume?: number;
  speechThreshold?: number;
  holdMs?: number;
  initialEnabled?: boolean;
  initialTargetVolume?: number;
}

export interface DuckingUpdateResult {
  changed: boolean;
  effectiveVolume: number;
  isDucked: boolean;
}

const DEFAULT_DUCK_VOLUME = 0.3;
const DEFAULT_SPEECH_THRESHOLD = 0.055;
const DEFAULT_HOLD_MS = 1200;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

export class QuickDuckingController {
  private readonly duckVolume: number;
  private readonly speechThreshold: number;
  private readonly holdMs: number;

  private enabled: boolean;
  private targetVolume: number;
  private isDucked = false;
  private lastSpeechAtMs: number | null = null;

  constructor(options: QuickDuckingOptions = {}) {
    this.duckVolume = clampUnit(options.duckVolume ?? DEFAULT_DUCK_VOLUME);
    this.speechThreshold = Math.max(0.005, options.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD);
    this.holdMs = Math.max(100, options.holdMs ?? DEFAULT_HOLD_MS);
    this.enabled = options.initialEnabled ?? false;
    this.targetVolume = clampUnit(options.initialTargetVolume ?? 1);
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getTargetVolume(): number {
    return this.targetVolume;
  }

  public getEffectiveVolume(): number {
    if (this.enabled && this.isDucked) {
      return Math.min(this.targetVolume, this.duckVolume);
    }
    return this.targetVolume;
  }

  public getIsDucked(): boolean {
    return this.isDucked;
  }

  public setEnabled(enabled: boolean): DuckingUpdateResult {
    const prevEffective = this.getEffectiveVolume();
    const prevDucked = this.isDucked;
    this.enabled = enabled;

    if (!enabled) {
      this.isDucked = false;
      this.lastSpeechAtMs = null;
    }

    const nextEffective = this.getEffectiveVolume();
    return {
      changed: prevDucked !== this.isDucked || Math.abs(prevEffective - nextEffective) > 0.001,
      effectiveVolume: nextEffective,
      isDucked: this.isDucked,
    };
  }

  public setTargetVolume(volume: number): DuckingUpdateResult {
    const prevEffective = this.getEffectiveVolume();
    this.targetVolume = clampUnit(volume);
    const nextEffective = this.getEffectiveVolume();

    return {
      changed: Math.abs(prevEffective - nextEffective) > 0.001,
      effectiveVolume: nextEffective,
      isDucked: this.isDucked,
    };
  }

  public processSpeechLevel(maxRms: number, nowMs: number): DuckingUpdateResult {
    if (!this.enabled) {
      return {
        changed: false,
        effectiveVolume: this.targetVolume,
        isDucked: false,
      };
    }

    if (maxRms >= this.speechThreshold) {
      this.lastSpeechAtMs = nowMs;
      if (!this.isDucked) {
        const prevEffective = this.getEffectiveVolume();
        this.isDucked = true;
        const nextEffective = this.getEffectiveVolume();
        return {
          changed: true,
          effectiveVolume: nextEffective,
          isDucked: prevEffective >= nextEffective ? true : true,
        };
      }
      return {
        changed: false,
        effectiveVolume: this.getEffectiveVolume(),
        isDucked: true,
      };
    }

    if (this.isDucked && this.lastSpeechAtMs !== null && nowMs - this.lastSpeechAtMs >= this.holdMs) {
      this.isDucked = false;
      this.lastSpeechAtMs = null;
      return {
        changed: true,
        effectiveVolume: this.targetVolume,
        isDucked: false,
      };
    }

    return {
      changed: false,
      effectiveVolume: this.getEffectiveVolume(),
      isDucked: this.isDucked,
    };
  }

  public reset(): DuckingUpdateResult {
    const wasDucked = this.isDucked;
    this.isDucked = false;
    this.lastSpeechAtMs = null;
    return {
      changed: wasDucked,
      effectiveVolume: this.targetVolume,
      isDucked: false,
    };
  }
}
