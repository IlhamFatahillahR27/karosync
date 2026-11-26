import { describe, expect, it } from 'vitest';
import { QuickDuckingController } from '../src/ducking';

describe('QuickDuckingController', () => {
  it('ducks YouTube volume to 30% during vocal speech and restores after holdMs', () => {
    const ducking = new QuickDuckingController({
      duckVolume: 0.3,
      speechThreshold: 0.05,
      holdMs: 1000,
      initialEnabled: true,
      initialTargetVolume: 0.85,
    });

    // Silence -> no change
    expect(ducking.processSpeechLevel(0.01, 100)).toEqual({
      changed: false,
      effectiveVolume: 0.85,
      isDucked: false,
    });

    // Speech detected -> ducks immediately to 0.3
    expect(ducking.processSpeechLevel(0.12, 200)).toEqual({
      changed: true,
      effectiveVolume: 0.3,
      isDucked: true,
    });

    // Silence shorter than holdMs -> stays ducked
    expect(ducking.processSpeechLevel(0.0, 900)).toEqual({
      changed: false,
      effectiveVolume: 0.3,
      isDucked: true,
    });

    // Silence exceeds holdMs -> restores target volume
    expect(ducking.processSpeechLevel(0.0, 1250)).toEqual({
      changed: true,
      effectiveVolume: 0.85,
      isDucked: false,
    });
  });

  it('never raises volume above targetVolume when ducked and restores on disable', () => {
    const ducking = new QuickDuckingController({
      duckVolume: 0.3,
      speechThreshold: 0.05,
      holdMs: 1000,
      initialEnabled: true,
      initialTargetVolume: 0.2,
    });

    const lowResult = ducking.processSpeechLevel(0.1, 100);
    expect(lowResult.isDucked).toBe(true);
    expect(lowResult.effectiveVolume).toBe(0.2);

    // Raise target to 0.9 while ducked -> effective stays capped at 0.3
    expect(ducking.setTargetVolume(0.9).effectiveVolume).toBe(0.3);

    // Disable ducking -> restores to 0.9 immediately
    expect(ducking.setEnabled(false)).toEqual({
      changed: true,
      effectiveVolume: 0.9,
      isDucked: false,
    });
  });
});
