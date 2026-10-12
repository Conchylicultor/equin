import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  loadYouTubeIframeApi,
  YouTubeIframeApiLoadError,
  type YTNamespace,
  type YTPlayer,
} from "./internal/iframe-api";
export {
  YouTubePlayerNotReadyError,
  type YouTubeAudio,
  type YouTubePlaybackState,
  type YouTubePlayerCallbacks,
  type YouTubePlayerController,
  type YouTubePlayerState,
  type YouTubeRange,
} from "./internal/controller";
export {
  useYouTubePlayer,
  useYouTubePlayerState,
  useYouTubePlayhead,
} from "./internal/hooks";
export {
  YouTubePlayer,
  type YouTubePlayerProps,
} from "./components/youtube-player";
export { createMediaClock, type MediaClock } from "./internal/media-clock";

export default {
  description:
    "Embedded YouTube player the app controls: loadYouTubeIframeApi (the IFrame API, loaded once), <YouTubePlayer controller videoId loop autoplay audio onReady onPlaying onError onStateChange/> bound to a useYouTubePlayer() controller (without controls the iframe takes no pointer, so YouTube draws no hover chrome, and a click opens the video on youtube.com at the playhead) (play, pause, isPlaying, isAdvancing, playRange for one pass then back to the loop, seek — re-cueing a video that has not started rather than starting it — getCurrentTime, getDuration, getPlaybackRate, setPlaybackRate resolving to the rate the video took), useYouTubePlayerState, useYouTubePlayhead (one read per animation frame while playing), and createMediaClock (a smoothed, slewed reading of the playhead for something slaved to it). Loops without polling: one timer to the loop's end, reset on every state change.",
  contributions: [],
} satisfies PluginDefinition;
