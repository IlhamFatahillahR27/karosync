export type WakeLockState = 'active' | 'inactive' | 'unsupported';

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface WakeLockControllerOptions {
  wakeLockApi?: WakeLockApiLike | null;
  documentTarget?: VisibilityDocumentLike | null;
  onStateChange?: (state: WakeLockState) => void;
}

export class WakeLockController {
  private readonly wakeLockApi: WakeLockApiLike | null;
  private readonly documentTarget: VisibilityDocumentLike | null;
  private readonly onStateChange?: (state: WakeLockState) => void;

  private sentinel: WakeLockSentinelLike | null = null;
  private sentinelReleaseHandler: (() => void) | null = null;
  private wantActive = false;
  private listeningVisibility = false;
  private state: WakeLockState;

  constructor(options: WakeLockControllerOptions = {}) {
    if (options.wakeLockApi !== undefined) {
      this.wakeLockApi = options.wakeLockApi;
    } else if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && navigator.wakeLock) {
      this.wakeLockApi = navigator.wakeLock as unknown as WakeLockApiLike;
    } else {
      this.wakeLockApi = null;
    }

    if (options.documentTarget !== undefined) {
      this.documentTarget = options.documentTarget;
    } else if (typeof document !== 'undefined') {
      this.documentTarget = document as unknown as VisibilityDocumentLike;
    } else {
      this.documentTarget = null;
    }

    this.onStateChange = options.onStateChange;
    this.state = this.wakeLockApi ? 'inactive' : 'unsupported';
  }

  public getState(): WakeLockState {
    return this.state;
  }

  public async acquire(): Promise<WakeLockState> {
    if (!this.wakeLockApi) {
      this.setState('unsupported');
      return this.state;
    }

    this.wantActive = true;
    this.attachVisibilityListener();
    return this.requestSentinel();
  }

  public async release(): Promise<void> {
    this.wantActive = false;
    this.detachVisibilityListener();

    const current = this.sentinel;
    this.detachSentinelListener();
    this.sentinel = null;

    if (current && !current.released) {
      try {
        await current.release();
      } catch {
        // Ignore release errors when browser already released the lock
      }
    }

    if (this.wakeLockApi) {
      this.setState('inactive');
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.wantActive || !this.documentTarget) {
      return;
    }
    if (this.documentTarget.visibilityState === 'visible' && (!this.sentinel || this.sentinel.released)) {
      void this.requestSentinel();
    }
  };

  private async requestSentinel(): Promise<WakeLockState> {
    if (!this.wakeLockApi || !this.wantActive) {
      return this.state;
    }

    if (this.sentinel && !this.sentinel.released) {
      this.setState('active');
      return this.state;
    }

    try {
      const sentinel = await this.wakeLockApi.request('screen');
      if (!this.wantActive) {
        try {
          await sentinel.release();
        } catch {
          // Ignore
        }
        this.setState('inactive');
        return this.state;
      }

      this.detachSentinelListener();
      this.sentinel = sentinel;
      const onReleased = () => {
        if (this.sentinel === sentinel) {
          this.detachSentinelListener();
          this.sentinel = null;
          if (this.wakeLockApi) {
            this.setState('inactive');
          }
        }
      };
      this.sentinelReleaseHandler = onReleased;
      sentinel.addEventListener('release', onReleased);

      this.setState('active');
    } catch {
      this.setState('inactive');
    }

    return this.state;
  }

  private attachVisibilityListener(): void {
    if (this.listeningVisibility || !this.documentTarget) {
      return;
    }
    this.documentTarget.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.listeningVisibility = true;
  }

  private detachVisibilityListener(): void {
    if (!this.listeningVisibility || !this.documentTarget) {
      return;
    }
    this.documentTarget.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.listeningVisibility = false;
  }

  private detachSentinelListener(): void {
    if (this.sentinel && this.sentinelReleaseHandler) {
      this.sentinel.removeEventListener('release', this.sentinelReleaseHandler);
    }
    this.sentinelReleaseHandler = null;
  }

  private setState(next: WakeLockState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.onStateChange?.(next);
  }
}
