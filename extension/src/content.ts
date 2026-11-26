// Self-contained YouTube Content Script (zero runtime imports so MV3 classic script works reliably)

type YouTubeControlMessage =
  | { type: 'GET_YT_STATUS' }
  | { type: 'SET_YT_VOLUME'; volume: number; muted?: boolean };

interface YouTubeStatusPayload {
  found: boolean;
  volume: number;
  muted: boolean;
  paused: boolean;
  title: string;
  url: string;
}

interface KaroSyncWindow extends Window {
  __karosyncContentLoaded?: boolean;
}

(function initKaroSyncYouTubeContentScript(): void {
  const win = window as KaroSyncWindow;
  if (win.__karosyncContentLoaded) {
    return;
  }
  win.__karosyncContentLoaded = true;

  let managedVolume: number | null = null;
  let managedMuted: boolean | null = null;
  let lastTrackKey = '';
  let reapplyTimer: ReturnType<typeof setTimeout> | null = null;

  function findMainVideo(): HTMLVideoElement | null {
    return (
      document.querySelector<HTMLVideoElement>('video.html5-main-video') ??
      document.querySelector<HTMLVideoElement>('video')
    );
  }

  function getCleanTitle(): string {
    const raw = document.title || '';
    const cleaned = raw.replace(/\s*-\s*YouTube\s*$/i, '').trim();
    return cleaned || 'YouTube';
  }

  function clampVolume(value: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.min(1, Math.max(0, value));
  }

  function applyVolumeToVideo(video: HTMLVideoElement, volume: number, muted?: boolean): void {
    const clamped = clampVolume(volume);
    video.volume = clamped;
    video.muted = muted !== undefined ? muted : clamped === 0;
  }

  function buildStatus(video: HTMLVideoElement | null): YouTubeStatusPayload {
    return {
      found: Boolean(video),
      volume: video ? clampVolume(video.volume) : 1,
      muted: video ? video.muted : false,
      paused: video ? video.paused : true,
      title: getCleanTitle(),
      url: window.location.href,
    };
  }

  function reapplyManagedVolumeOnTrackChange(force = false): void {
    if (managedVolume === null) {
      return;
    }
    const video = findMainVideo();
    if (!video) {
      return;
    }

    const trackKey = `${window.location.href}|${video.currentSrc}`;
    if (!force && trackKey === lastTrackKey) {
      return;
    }
    lastTrackKey = trackKey;

    const targetVolume = managedVolume;
    const targetMuted = managedMuted ?? targetVolume === 0;
    applyVolumeToVideo(video, targetVolume, targetMuted);

    // YouTube's internal player sometimes restores its persisted volume shortly after navigation
    if (reapplyTimer !== null) {
      clearTimeout(reapplyTimer);
    }
    reapplyTimer = setTimeout(() => {
      reapplyTimer = null;
      const latestVideo = findMainVideo();
      if (latestVideo && managedVolume !== null) {
        applyVolumeToVideo(
          latestVideo,
          managedVolume,
          managedMuted ?? managedVolume === 0,
        );
      }
    }, 250);
  }

  window.addEventListener('yt-navigate-finish', () => {
    reapplyManagedVolumeOnTrackChange(true);
  });

  document.addEventListener(
    'loadedmetadata',
    (event) => {
      if (event.target instanceof HTMLVideoElement) {
        reapplyManagedVolumeOnTrackChange(false);
      }
    },
    true,
  );

  chrome.runtime.onMessage.addListener(
    (message: YouTubeControlMessage | undefined, _sender, sendResponse) => {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        return false;
      }

      const video = findMainVideo();

      if (message.type === 'GET_YT_STATUS') {
        sendResponse(buildStatus(video));
        return true;
      }

      if (message.type === 'SET_YT_VOLUME') {
        const clamped = clampVolume(message.volume);
        managedVolume = clamped;
        managedMuted = message.muted !== undefined ? message.muted : clamped === 0;

        if (video) {
          lastTrackKey = `${window.location.href}|${video.currentSrc}`;
          applyVolumeToVideo(video, clamped, managedMuted);
        }

        sendResponse({
          ok: Boolean(video),
          ...buildStatus(video),
        });
        return true;
      }

      return false;
    },
  );
})();
