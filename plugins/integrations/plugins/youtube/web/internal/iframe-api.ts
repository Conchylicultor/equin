/**
 * The slice of the YouTube IFrame Player API this plugin drives, typed here
 * rather than through `@types/youtube` (not a dependency of the repo). Only
 * what the controller calls is declared.
 *
 * Reference: https://developers.google.com/youtube/iframe_api_reference
 */

/** `YT.PlayerState`: the numeric codes `onStateChange` delivers. */
export interface YTPlayerStateCodes {
  readonly UNSTARTED: -1;
  readonly ENDED: 0;
  readonly PLAYING: 1;
  readonly PAUSED: 2;
  readonly BUFFERING: 3;
  readonly CUED: 5;
}

export interface YTVideoRequest {
  videoId: string;
  startSeconds?: number;
}

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  /**
   * Note: on a CUED or UNSTARTED video, seeking also STARTS playback (the API's
   * documented behaviour). Only a paused player stays paused — the controller
   * re-cues at the time instead (`cueVideoById`), see `seekPlayer`.
   */
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  /** 0 until the video's metadata has loaded. */
  getDuration(): number;
  getPlaybackRate(): number;
  /**
   * Ask for a rate. Only the rates `getAvailablePlaybackRates()` lists are
   * taken; `onPlaybackRateChange` fires once the rate really changed.
   */
  setPlaybackRate(rate: number): void;
  /**
   * The rates this video supports (`[1]` for some, e.g. live streams).
   * `undefined` until the video has loaded — a cued video that never played
   * answers nothing (seen in Chromium, 2026-10-07).
   */
  getAvailablePlaybackRates(): number[] | undefined;
  getPlayerState(): number;
  /** 0–100. Independent of `mute`: an unmuted player comes back at this level. */
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  loadVideoById(request: YTVideoRequest): void;
  cueVideoById(request: YTVideoRequest): void;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
}

export interface YTPlayerEvent {
  target: YTPlayer;
}
export interface YTNumberEvent extends YTPlayerEvent {
  data: number;
}

export interface YTPlayerOptions {
  width?: string | number;
  height?: string | number;
  videoId?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: YTPlayerEvent) => void;
    onStateChange?: (event: YTNumberEvent) => void;
    onError?: (event: YTNumberEvent) => void;
    onPlaybackRateChange?: (event: YTNumberEvent) => void;
  };
}

/** The `YT` global the IFrame API script defines. */
export interface YTNamespace {
  Player: new (element: HTMLElement, options: YTPlayerOptions) => YTPlayer;
  PlayerState: YTPlayerStateCodes;
  /** `1` once the API has finished loading (set by the script itself). */
  loaded?: number;
}

/**
 * The window the IFrame API script defines `YT` on and calls back. A cast
 * where it is used, not a `Window` augmentation: a global declaration makes
 * every edit to the file holding it re-check the whole repo.
 */
type YouTubeWindow = Window & {
  YT?: YTNamespace;
  onYouTubeIframeAPIReady?: () => void;
};

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

export class YouTubeIframeApiLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeIframeApiLoadError";
  }
}

let apiPromise: Promise<YTNamespace> | undefined;

/**
 * Loads `https://www.youtube.com/iframe_api` once per page and resolves with
 * the `YT` namespace once the API is ready. Every caller shares one promise.
 *
 * The script announces readiness by calling the global
 * `onYouTubeIframeAPIReady`; a handler someone else installed first is chained,
 * not replaced. A script tag already on the page (injected by other code) is
 * reused rather than added twice.
 *
 * A failed load rejects with `YouTubeIframeApiLoadError` and clears the memo,
 * so the next caller (a remounted player) tries again.
 */
export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const w = window as YouTubeWindow;
    const ready = w.YT;
    if (ready?.loaded === 1) {
      resolve(ready);
      return;
    }

    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      const yt = w.YT;
      if (yt === undefined) {
        reject(
          new YouTubeIframeApiLoadError(
            "onYouTubeIframeAPIReady fired but window.YT is not defined",
          ),
        );
        return;
      }
      resolve(yt);
    };

    if (document.querySelector(`script[src="${IFRAME_API_SRC}"]`) !== null) {
      return;
    }
    const script = document.createElement("script");
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.onerror = () => {
      script.remove();
      reject(new YouTubeIframeApiLoadError(`Could not load ${IFRAME_API_SRC}`));
    };
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    apiPromise = undefined;
    throw err;
  });
  return apiPromise;
}
