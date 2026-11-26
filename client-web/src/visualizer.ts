import type { AudioCaptureLike } from './mic-session';

export type VisualizerMode = 'idle' | 'active' | 'self_muted' | 'host_muted';

export interface VisualizerOptions {
  canvas: HTMLCanvasElement;
  audioCapture: AudioCaptureLike;
  onLevelUpdate?: (levelPercent: number, clipping: boolean) => void;
}

const BAR_COUNT = 28;

export class AudioVisualizer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly audioCapture: AudioCaptureLike;
  private readonly onLevelUpdate?: (levelPercent: number, clipping: boolean) => void;

  private readonly smoothedBars: number[] = Array.from({ length: BAR_COUNT }, () => 0.06);
  private mode: VisualizerMode = 'idle';
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private width = 300;
  private height = 96;
  private lastLevelEmit = 0;

  constructor(options: VisualizerOptions) {
    this.canvas = options.canvas;
    this.ctx = options.canvas.getContext('2d');
    this.audioCapture = options.audioCapture;
    this.onLevelUpdate = options.onLevelUpdate;

    this.resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
        if (this.rafId === null) {
          this.drawFrame();
        }
      });
      this.resizeObserver.observe(this.canvas);
    }

    this.drawFrame();
  }

  public setMode(mode: VisualizerMode): void {
    this.mode = mode;
    if (mode === 'idle') {
      this.stop();
      for (let i = 0; i < BAR_COUNT; i += 1) {
        this.smoothedBars[i] = 0.06;
      }
      this.onLevelUpdate?.(0, false);
      this.drawFrame();
      return;
    }

    this.start();
  }

  public start(): void {
    if (this.rafId !== null) {
      return;
    }
    this.resizeCanvas();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.drawFrame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public destroy(): void {
    this.stop();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  private resizeCanvas(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(180, Math.round(rect.width || this.canvas.clientWidth || 300));
    const cssHeight = Math.max(64, Math.round(rect.height || this.canvas.clientHeight || 96));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.width = cssWidth;
    this.height = cssHeight;

    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    if (this.ctx) {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private drawFrame(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const { levels, frequencyBins } =
      this.mode === 'active'
        ? this.audioCapture.sampleAudio()
        : { levels: { rms: 0, peak: 0, clipping: false }, frequencyBins: null };

    const now = performance.now();
    if (this.onLevelUpdate && now - this.lastLevelEmit >= 60) {
      this.lastLevelEmit = now;
      this.onLevelUpdate(Math.round(levels.rms * 100), levels.clipping);
    }

    const half = BAR_COUNT / 2;
    for (let i = 0; i < BAR_COUNT; i += 1) {
      let target = 0.06;

      if (this.mode === 'active' && frequencyBins && frequencyBins.length > 0) {
        // Mirror low-to-mid vocal spectrum symmetrically from center outward
        const distanceFromCenter = Math.abs(i - (half - 0.5)) / half;
        const maxVocalBin = Math.min(frequencyBins.length - 1, 44);
        const binIndex = Math.min(
          maxVocalBin,
          Math.max(1, Math.round(distanceFromCenter * maxVocalBin)),
        );
        const magnitude = (frequencyBins[binIndex] ?? 0) / 255;
        target = Math.max(0.08, Math.min(1, magnitude * 1.12 + levels.rms * 0.25));
      } else if (this.mode === 'host_muted') {
        target = 0.09;
      } else if (this.mode === 'self_muted') {
        target = 0.05;
      }

      const prev = this.smoothedBars[i] ?? 0.06;
      const smoothing = target > prev ? 0.45 : 0.2;
      this.smoothedBars[i] = prev + (target - prev) * smoothing;
    }

    ctx.clearRect(0, 0, this.width, this.height);

    // Subtle center baseline
    ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.fillRect(0, this.height / 2 - 0.5, this.width, 1);

    const gap = 4;
    const totalGaps = gap * (BAR_COUNT - 1);
    const barWidth = Math.max(3, (this.width - totalGaps) / BAR_COUNT);
    const maxBarHeight = this.height - 12;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      const value = this.smoothedBars[i] ?? 0.06;
      const barHeight = Math.max(4, value * maxBarHeight);
      const x = i * (barWidth + gap);
      const y = (this.height - barHeight) / 2;

      if (this.mode === 'host_muted') {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.48)';
      } else if (this.mode === 'self_muted' || this.mode === 'idle') {
        ctx.fillStyle = 'rgba(100, 116, 139, 0.35)';
      } else if (levels.clipping || value > 0.88) {
        ctx.fillStyle = '#fb7185';
      } else if (value > 0.62) {
        ctx.fillStyle = '#34d399';
      } else {
        ctx.fillStyle = '#22d3ee';
      }

      this.drawRoundedRect(ctx, x, y, barWidth, barHeight, Math.min(barWidth / 2, 4));
    }
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  }
}
