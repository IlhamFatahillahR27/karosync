import { describe, expect, it, vi } from 'vitest';
import {
  YouTubeController,
  type ChromeTabLike,
  type ChromeYouTubeApiLike,
} from '../src/youtube-controller';

describe('YouTubeController', () => {
  it('queries active YouTube tab and sends GET_YT_STATUS / SET_YT_VOLUME', async () => {
    const activeTab: ChromeTabLike = {
      id: 42,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      active: true,
    };

    const api: ChromeYouTubeApiLike = {
      queryTabs: vi.fn(async () => [activeTab]),
      sendMessage: vi.fn(async (_tabId, msg) => {
        if (msg.type === 'GET_YT_STATUS') {
          return {
            found: true,
            volume: 0.7,
            muted: false,
            paused: false,
            title: 'Karaoke Song',
            url: activeTab.url!,
          };
        }
        return {
          ok: true,
          found: true,
          volume: msg.volume,
          muted: false,
          paused: false,
          title: 'Karaoke Song',
          url: activeTab.url!,
        };
      }) as ChromeYouTubeApiLike['sendMessage'],
      injectContentScript: vi.fn(async () => undefined),
    };

    const controller = new YouTubeController(api);

    const status = await controller.getStatus();
    expect(status?.found).toBe(true);
    expect(status?.volume).toBe(0.7);

    const volRes = await controller.setVolume(1.5);
    expect(volRes?.volume).toBe(1);
    expect(api.injectContentScript).not.toHaveBeenCalled();
  });

  it('auto-injects content.js and retries once if content script is not yet loaded', async () => {
    let attempts = 0;
    const api: ChromeYouTubeApiLike = {
      queryTabs: vi.fn(async () => [
        { id: 9, url: 'https://www.youtube.com/watch?v=abc', active: true },
      ]),
      sendMessage: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return {
          found: true,
          volume: 0.5,
          muted: false,
          paused: false,
          title: 'Recovered Tab',
          url: 'https://www.youtube.com/watch?v=abc',
        };
      }) as ChromeYouTubeApiLike['sendMessage'],
      injectContentScript: vi.fn(async () => undefined),
    };

    const controller = new YouTubeController(api);
    const status = await controller.getStatus();

    expect(api.injectContentScript).toHaveBeenCalledWith(9);
    expect(status?.title).toBe('Recovered Tab');
  });
});
