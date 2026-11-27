import { describe, expect, it, vi } from 'vitest';
import {
  AudioMixer,
  COMPRESSOR_PRESETS,
  type AnalyserNodeLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BiquadFilterNodeLike,
  type DynamicsCompressorNodeLike,
  type GainNodeLike,
  type HiddenAudioElementLike,
} from '../src/audio-mixer';

function createFakeAudioParam(initial = 0) {
  return {
    value: initial,
    setTargetAtTime(target: number) {
      this.value = target;
    },
  };
}

class FakeNode implements AudioNodeLike {
  public connectedTo: AudioNodeLike[] = [];
  public disconnected = false;
  public connect(dest: AudioNodeLike): AudioNodeLike {
    this.connectedTo.push(dest);
    return dest;
  }
  public disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeNode implements GainNodeLike {
  public readonly gain = createFakeAudioParam(1);
}

class FakeAnalyserNode extends FakeNode implements AnalyserNodeLike {
  public fftSize = 256;
  public smoothingTimeConstant = 0.75;
  public readonly frequencyBinCount = 128;
  public sampleValue = 0.25;

  public getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void {
    array.fill(this.sampleValue);
  }

  public getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void {
    array.fill(128);
  }
}

class FakeCompressorNode extends FakeNode implements DynamicsCompressorNodeLike {
  public readonly threshold = createFakeAudioParam(0);
  public readonly knee = createFakeAudioParam(0);
  public readonly ratio = createFakeAudioParam(1);
  public readonly attack = createFakeAudioParam(0);
  public readonly release = createFakeAudioParam(0);
  public reduction = -3.5;
}

class FakeBiquadFilterNode extends FakeNode implements BiquadFilterNodeLike {
  public type: BiquadFilterType = 'lowpass';
  public readonly frequency = createFakeAudioParam(350);
  public readonly Q = createFakeAudioParam(1);
}

class FakeAudioContext implements AudioContextLike {
  public state: AudioContextState = 'running';
  public currentTime = 0;
  public baseLatency = 0.01;
  public outputLatency = 0.015;
  public readonly destination: AudioNodeLike = new FakeNode();
  public gains: FakeGainNode[] = [];
  public analysers: FakeAnalyserNode[] = [];
  public compressors: FakeCompressorNode[] = [];
  public filters: FakeBiquadFilterNode[] = [];
  public sources: FakeNode[] = [];
  public closed = false;

  public createMediaStreamSource(): AudioNodeLike {
    const node = new FakeNode();
    this.sources.push(node);
    return node;
  }

  public createGain(): GainNodeLike {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  public createAnalyser(): AnalyserNodeLike {
    const node = new FakeAnalyserNode();
    this.analysers.push(node);
    return node;
  }

  public createDynamicsCompressor(): DynamicsCompressorNodeLike {
    const node = new FakeCompressorNode();
    this.compressors.push(node);
    return node;
  }

  public createBiquadFilter(): BiquadFilterNodeLike {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  public async resume(): Promise<void> {
    this.state = 'running';
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }
}

describe('AudioMixer', () => {
  it('wires per-peer source -> gain -> analyser -> masterGain -> compressor -> destination', async () => {
    const ctx = new FakeAudioContext();
    const sinks: HiddenAudioElementLike[] = [];

    const mixer = new AudioMixer({
      audioContextFactory: () => ctx,
      audioElementFactory: () => {
        const el: HiddenAudioElementLike = {
          muted: false,
          autoplay: false,
          srcObject: null,
          play: vi.fn(async () => undefined),
          pause: vi.fn(),
        };
        sinks.push(el);
        return el;
      },
    });

    const fakeStream = { id: 'mic-1' } as unknown as MediaStream;
    mixer.attachStream('client-1', fakeStream);

    // Master bus: masterGain (gains[0]) -> compressor[0] -> destination
    const masterGain = ctx.gains[0]!;
    const compressor = ctx.compressors[0]!;
    expect(masterGain.connectedTo).toContain(compressor);
    expect(compressor.connectedTo).toContain(ctx.destination);
    expect(compressor.threshold.value).toBe(-18);
    expect(compressor.ratio.value).toBe(8);

    // Peer bus: source[0] -> hpf[0] -> peerGain (gains[1]) -> analyser[0] -> gateGain (gains[2]) -> masterGain
    const peerSource = ctx.sources[0]!;
    const peerHpf = ctx.filters[0]!;
    const peerGain = ctx.gains[1]!;
    const peerAnalyser = ctx.analysers[0]!;
    const peerGateGain = ctx.gains[2]!;
    expect(peerHpf.type).toBe('highpass');
    expect(peerHpf.frequency.value).toBe(120);
    expect(peerSource.connectedTo).toContain(peerHpf);
    expect(peerHpf.connectedTo).toContain(peerGain);
    expect(peerGain.connectedTo).toContain(peerAnalyser);
    expect(peerAnalyser.connectedTo).toContain(peerGateGain);
    expect(peerGateGain.connectedTo).toContain(masterGain);

    // Hidden muted audio sink created for Chromium WebRTC pull workaround
    expect(sinks[0]!.muted).toBe(true);
    expect(sinks[0]!.srcObject).toBe(fakeStream);

    // Noise Gate keeps quiet speaker bleed closed until vocal crosses threshold
    peerAnalyser.sampleValue = 0.01;
    const quietSnap = mixer.sampleLevels(1000);
    expect(quietSnap.levels.get('client-1')!.gateOpen).toBe(false);
    expect(peerGateGain.gain.value).toBe(0);
    expect(quietSnap.maxActiveRms).toBe(0);

    // Vocal signal above threshold opens Noise Gate cleanly
    peerAnalyser.sampleValue = 0.25;
    const snapshot = mixer.sampleLevels(1100);
    expect(snapshot.levels.get('client-1')!.gateOpen).toBe(true);
    expect(peerGateGain.gain.value).toBe(1);
    expect(snapshot.levels.get('client-1')!.rms).toBeCloseTo(0.25, 4);
    expect(snapshot.maxActiveRms).toBeCloseTo(0.25, 4);
    expect(snapshot.compressorReductionDb).toBe(-3.5);

    // Gate holds open briefly (< holdMs) then closes cleanly after holdMs
    peerAnalyser.sampleValue = 0.005;
    expect(mixer.sampleLevels(1200).levels.get('client-1')!.gateOpen).toBe(true);
    expect(mixer.sampleLevels(1500).levels.get('client-1')!.gateOpen).toBe(false);
    expect(peerGateGain.gain.value).toBe(0);

    // Disabling Anti-Feedback DSP bypasses HPF (allpass) and opens Noise Gate
    mixer.setAntiFeedbackDsp({ highPassEnabled: false, noiseGateEnabled: false });
    expect(peerHpf.type).toBe('allpass');
    expect(peerGateGain.gain.value).toBe(1);
    mixer.setAntiFeedbackDsp({ highPassEnabled: true, noiseGateEnabled: true });

    // Host mute sets gain to 0 and zeroes reported VU/speech RMS
    peerAnalyser.sampleValue = 0.25;
    mixer.setPeerMuted('client-1', true);
    expect(peerGain.gain.value).toBe(0);
    const mutedSnapshot = mixer.sampleLevels(1600);
    expect(mutedSnapshot.levels.get('client-1')!.rms).toBe(0);
    expect(mutedSnapshot.levels.get('client-1')!.gateOpen).toBe(false);
    expect(mutedSnapshot.maxActiveRms).toBe(0);

    // Unmute restores previous peer volume
    mixer.setPeerVolume('client-1', 1.25);
    mixer.setPeerMuted('client-1', false);
    expect(peerGain.gain.value).toBe(1.25);

    // Live compressor tuning updates DynamicsCompressorNode & clamps safely
    const tvSafe = mixer.setCompressorSettings(COMPRESSOR_PRESETS.tv_safe);
    expect(tvSafe.threshold).toBe(-22);
    expect(tvSafe.ratio).toBe(12);
    expect(compressor.threshold.value).toBe(-22);
    expect(compressor.ratio.value).toBe(12);

    const clamped = mixer.setCompressorSettings({ threshold: -99, ratio: 50 });
    expect(clamped.threshold).toBe(-40);
    expect(clamped.ratio).toBe(20);
    expect(mixer.getCompressorSettings().threshold).toBe(-40);

    // Reports combined baseLatency + outputLatency in milliseconds
    expect(mixer.getOutputLatencyMs()).toBe(25);

    // Dispose cleans up nodes, sink, and AudioContext
    await mixer.dispose();
    expect(peerSource.disconnected).toBe(true);
    expect(sinks[0]!.srcObject).toBeNull();
    expect(ctx.closed).toBe(true);
  });
});
