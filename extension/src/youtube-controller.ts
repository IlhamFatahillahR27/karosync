import type {
  YouTubeActionResponse,
  YouTubeControlMessage,
  YouTubeStatusResponse,
} from './protocol';

export interface ChromeTabLike {
  id?: number;
  url?: string;
  title?: string;
  audible?: boolean;
  active?: boolean;
}

export interface ChromeYouTubeApiLike {
  queryTabs(queryInfo: chrome.tabs.QueryInfo): Promise<ChromeTabLike[]>;
  sendMessage<TResponse>(tabId: number, message: YouTubeControlMessage): Promise<TResponse>;
  injectContentScript(tabId: number): Promise<void>;
}

const YOUTUBE_URL_PATTERN = '*://www.youtube.com/*';

function isYouTubeUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname === 'www.youtube.com'
    );
  } catch {
    return false;
  }
}

function createDefaultChromeApi(): ChromeYouTubeApiLike {
  return {
    queryTabs: (queryInfo) => chrome.tabs.query(queryInfo),
    sendMessage: <TResponse>(tabId: number, message: YouTubeControlMessage) =>
      chrome.tabs.sendMessage<YouTubeControlMessage, TResponse>(tabId, message),
    injectContentScript: async (tabId: number) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
    },
  };
}

export class YouTubeController {
  private readonly api: ChromeYouTubeApiLike;
  private lastTabId: number | null = null;

  constructor(api?: ChromeYouTubeApiLike) {
    this.api = api ?? createDefaultChromeApi();
  }

  public async getStatus(): Promise<YouTubeStatusResponse | null> {
    return this.dispatchToYouTubeTab<YouTubeStatusResponse>({ type: 'GET_YT_STATUS' });
  }

  public async setVolume(volume: number, muted?: boolean): Promise<YouTubeActionResponse | null> {
    const clamped = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    const message: YouTubeControlMessage = {
      type: 'SET_YT_VOLUME',
      volume: clamped,
      ...(muted !== undefined ? { muted } : {}),
    };
    return this.dispatchToYouTubeTab<YouTubeActionResponse>(message);
  }

  public resetTrackedTab(): void {
    this.lastTabId = null;
  }

  private async resolveYouTubeTabId(): Promise<number | null> {
    try {
      const activeTabs = await this.api.queryTabs({ active: true, currentWindow: true });
      const activeTab = activeTabs[0];
      if (activeTab?.id !== undefined && isYouTubeUrl(activeTab.url)) {
        this.lastTabId = activeTab.id;
        return activeTab.id;
      }

      const ytTabs = await this.api.queryTabs({ url: YOUTUBE_URL_PATTERN, currentWindow: true });
      if (ytTabs.length === 0) {
        return null;
      }

      // Prefer previously controlled tab, then audible tab, then first YouTube tab in window
      const remembered =
        this.lastTabId !== null ? ytTabs.find((tab) => tab.id === this.lastTabId) : undefined;
      if (remembered?.id !== undefined) {
        return remembered.id;
      }

      const audible = ytTabs.find((tab) => tab.audible && tab.id !== undefined);
      if (audible?.id !== undefined) {
        this.lastTabId = audible.id;
        return audible.id;
      }

      const first = ytTabs.find((tab) => tab.id !== undefined);
      if (first?.id !== undefined) {
        this.lastTabId = first.id;
        return first.id;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async dispatchToYouTubeTab<TResponse>(
    message: YouTubeControlMessage,
  ): Promise<TResponse | null> {
    const tabId = await this.resolveYouTubeTabId();
    if (tabId === null) {
      return null;
    }

    try {
      return await this.api.sendMessage<TResponse>(tabId, message);
    } catch {
      // Content script may not be loaded on a YouTube tab opened prior to extension load
      try {
        await this.api.injectContentScript(tabId);
        return await this.api.sendMessage<TResponse>(tabId, message);
      } catch {
        if (this.lastTabId === tabId) {
          this.lastTabId = null;
        }
        return null;
      }
    }
  }
}
