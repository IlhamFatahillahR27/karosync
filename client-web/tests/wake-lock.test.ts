import { describe, expect, it, vi } from 'vitest';
import {
  WakeLockController,
  type VisibilityDocumentLike,
  type WakeLockApiLike,
  type WakeLockSentinelLike,
  type WakeLockState,
} from '../src/wake-lock';

class FakeSentinel implements WakeLockSentinelLike {
  public released = false;
  private listeners = new Set<() => void>();

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public simulateSystemRelease(): void {
    this.released = true;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.add(listener);
  }

  public removeEventListener(_type: 'release', listener: () => void): void {
    this.listeners.delete(listener);
  }
}

class FakeDocument implements VisibilityDocumentLike {
  public visibilityState = 'visible';
  private listeners = new Set<() => void>();

  public addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  public removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  public setVisibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe('WakeLockController', () => {
  it('degrades gracefully when Screen Wake Lock API is unsupported', async () => {
    const controller = new WakeLockController({
      wakeLockApi: null,
      documentTarget: null,
    });

    expect(controller.getState()).toBe('unsupported');
    expect(await controller.acquire()).toBe('unsupported');
    await controller.release();
    expect(controller.getState()).toBe('unsupported');
  });

  it('acquires, re-acquires on visibilitychange, and releases cleanly', async () => {
    const sentinels: FakeSentinel[] = [];
    const requestMock = vi.fn(async () => {
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    });
    const wakeLockApi: WakeLockApiLike = { request: requestMock };
    const doc = new FakeDocument();
    const transitions: WakeLockState[] = [];

    const controller = new WakeLockController({
      wakeLockApi,
      documentTarget: doc,
      onStateChange: (state) => transitions.push(state),
    });

    expect(controller.getState()).toBe('inactive');

    // Acquire initially
    expect(await controller.acquire()).toBe('active');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('screen');

    // Simulate OS releasing wake lock when tab goes hidden
    doc.setVisibility('hidden');
    sentinels[0]?.simulateSystemRelease();
    expect(controller.getState()).toBe('inactive');

    // Returning to visible should re-acquire wake lock automatically
    doc.setVisibility('visible');
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toBe('active');

    // Manual release stops tracking and releases sentinel
    await controller.release();
    expect(controller.getState()).toBe('inactive');
    expect(sentinels[1]?.released).toBe(true);

    // Further visibilitychange does NOT re-acquire after release
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(transitions).toEqual(['active', 'inactive', 'active', 'inactive']);
  });
});
