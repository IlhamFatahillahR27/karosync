type YouTubeControlMessage =
  | { type: 'SET_YT_VOLUME'; volume: number }
  | { type: 'GET_YT_STATUS' };

chrome.runtime.onMessage.addListener(
  (message: YouTubeControlMessage, _sender, sendResponse) => {
    const video = document.querySelector<HTMLVideoElement>('video');

    if (message.type === 'GET_YT_STATUS') {
      sendResponse({
        found: Boolean(video),
        volume: video?.volume ?? 1,
        muted: video?.muted ?? false,
        paused: video?.paused ?? true,
      });
      return true;
    }

    if (message.type === 'SET_YT_VOLUME') {
      if (video) {
        const clamped = Math.min(1, Math.max(0, message.volume));
        video.volume = clamped;
        video.muted = clamped === 0;
      }
      sendResponse({ ok: Boolean(video) });
      return true;
    }

    return false;
  },
);
