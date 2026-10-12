import { snapPlaybackRate } from "../../core";
import type { YTNamespace, YTPlayer, YTPlayerStateCodes } from "./iframe-api";

/** A stretch of the video, in seconds: `[start, end)`. */
export interface YouTubeRange {
  start: number;
  end: number;
}

/**
 * What the viewer hears. `volume` is 0–100; `muted` silences the video
 * without pausing it, so a muted video still keeps time for whatever follows
 * its playhead.
 */
export interface YouTubeAudio {
  volume: number;
  muted: boolean;
}

/** What the player reports about itself, for rendering. */
export type YouTubePlayerState =
  /** The API script or the player iframe is not ready yet. */
  | { kind: "loading" }
  | {
      kind: "ready";
      videoId: string;
      /** Playing, or buffering on the way to playing. */
      playing: boolean;
      /**
       * This video has played at least once since it loaded — so the iframe
       * holds one of its frames, not YouTube's cued title card.
       */
      started: boolean;
      /** Seconds, or `null` until the video's metadata has loaded. */
      duration: number | null;
    }
  /** YouTube refused this video. `code` is the IFrame API's error code. */
  | { kind: "error"; videoId: string; code: number };

/** The IFrame API's player states, by name. */
export type YouTubePlaybackState =
  "unstarted" | "ended" | "playing" | "paused" | "buffering" | "cued";

export interface YouTubePlayerCallbacks {
  /** Once per loaded video, when its duration is known. */
  onReady?: (duration: number) => void;
  /** Once per loaded video, the first time it actually plays. */
  onPlaying?: () => void;
  /**
   * YouTube refused the video. Codes: 2 bad parameter, 5 HTML5 player error,
   * 100 not found or private, 101 / 150 embedding not allowed (150 also covers
   * region blocks and sign-in-required videos).
   */
  onError?: (code: number) => void;
  /** Every raw state change, by name. */
  onStateChange?: (state: YouTubePlaybackState) => void;
}

/** What `<YouTubePlayer>` asks the controller to show. */
export interface YouTubeSource {
  videoId: string;
  loop: YouTubeRange | null;
  autoplay: boolean;
  /** `null` leaves the audio as YouTube has it. */
  audio: YouTubeAudio | null;
}

/**
 * The imperative handle on one embedded player — see the plugin CLAUDE.md for
 * the looping contract. Created by `useYouTubePlayer()`, bound to an iframe by
 * `<YouTubePlayer controller>`.
 */
export interface YouTubePlayerController {
  /**
   * Play. With a loop and the playhead outside it, starts from the loop's
   * start. Throws `YouTubePlayerNotReadyError` before the player is ready.
   */
  play(): void;
  pause(): void;
  /** Playing, or buffering on the way to playing. `false` before ready. */
  readonly isPlaying: boolean;
  /** Strictly playing: media time is advancing (not buffering, not paused). */
  readonly isAdvancing: boolean;
  /**
   * Play `[start, end)` once, then go back to looping `loop` from its start
   * (or pause at `end` when there is no loop). A later `seek` cancels the pass.
   */
  playRange(start: number, end: number): void;
  /** Jump to `seconds`. Cancels a `playRange` pass in progress. */
  seek(seconds: number): void;
  getCurrentTime(): number;
  /** Seconds, or `null` until the video's metadata has loaded. */
  getDuration(): number | null;
  /** The rate the video plays at (1 = normal speed). */
  getPlaybackRate(): number;
  /**
   * Ask for a playback rate. The video takes only the rates it supports, so
   * the request is snapped to one (`snapPlaybackRate`: the nearest, and at
   * least one step off the current rate toward the request), and the promise
   * resolves to the rate the player reports once it really changed — never a
   * rate it is not playing. Requests made before the player answered share one
   * promise, which resolves to where the LAST of them lands.
   */
  setPlaybackRate(rate: number): Promise<number>;

  /** `useSyncExternalStore` pair for the player's state. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): YouTubePlayerState;

  /**
   * `useSyncExternalStore` pair for the playhead: while at least one listener
   * is subscribed and the video plays, the time is read once per animation
   * frame. `getPlayhead` is `null` while the player is not ready.
   */
  subscribePlayhead(listener: () => void): () => void;
  getPlayhead(): number | null;
}

export class YouTubePlayerNotReadyError extends Error {
  constructor(method: string) {
    super(
      `YouTubePlayerController.${method}() was called before the player was ready — gate it on useYouTubePlayerState(controller).kind === "ready"`,
    );
    this.name = "YouTubePlayerNotReadyError";
  }
}

/**
 * How close to a boundary counts as "reached". The timer fires on wall time,
 * the video runs on media time, and the two drift by a few milliseconds; a
 * boundary this close is treated as hit rather than re-armed for a sliver.
 */
const BOUNDARY_EPSILON_S = 0.05;
/** The shortest re-arm, so a video lagging its deadline cannot spin the timer. */
const MIN_REARM_MS = 15;
/**
 * The IFrame API's `getCurrentTime()` is the last value the iframe posted, not
 * a live read, so it can trail by a few hundred milliseconds. While the video
 * advances, the time is extrapolated from the last change by wall time — at
 * most this far, so a stall the player never reported cannot run away.
 */
const MAX_EXTRAPOLATION_S = 0.5;

const STATE_NAMES: Partial<Record<number, YouTubePlaybackState>> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
  5: "cued",
};

interface Attached {
  player: YTPlayer;
  codes: YTPlayerStateCodes;
  /** `true` once the IFrame API's `onReady` has fired. */
  ready: boolean;
  /** The video the player holds (last loaded or cued). */
  videoId: string | null;
  duration: number | null;
  readyAnnounced: boolean;
  playingAnnounced: boolean;
  error: number | null;
  /** Playing, or buffering on the way to playing (what the UI shows). */
  playing: boolean;
  /** Strictly PLAYING: media time is advancing. */
  advancing: boolean;
  /**
   * A cue sent and not yet reported (CUED). The iframe applies a cue whenever
   * it lands, so a command sent meanwhile can be undone by it (a play landing
   * cued, a seek snapped back) — a seek or play of the unstarted video is
   * HELD in `held` until the cue is reported, then sent in order.
   */
  cueInFlight: boolean;
  /** A play was sent and not paused since: the video is starting, so a seek is a plain `seekTo`, never a re-cue (which would stop it). */
  playSent: boolean;
  /** The start time of the last cue sent. */
  cuedAt: number;
  /** What the unstarted video was asked while a cue was in flight: a time to cue (null: none) and whether to play. */
  held: { seconds: number | null; play: boolean } | null;
  /** Last distinct raw `getCurrentTime()`, the media time it stands for, and when it was seen. */
  anchor: { raw: number; media: number; wall: number } | null;
}

/**
 * A rate request in flight. `target` is the snapped rate sent to the player,
 * or `null` while the request is HELD: before the video has played it lists
 * no rates, so `requested` waits for the first PLAYING to be snapped and sent.
 * Every request until the player answers shares `promise`.
 */
interface PendingRate {
  target: number | null;
  requested: number;
  promise: Promise<number>;
  resolve: (rate: number) => void;
}

export class YouTubePlayerControllerImpl implements YouTubePlayerController {
  private attached: Attached | null = null;
  private source: YouTubeSource | null = null;
  private callbacks: () => YouTubePlayerCallbacks = () => ({});
  /** A `playRange` pass in progress; takes precedence over the loop. */
  private pass: YouTubeRange | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  /** A rate asked for that the player has not reported yet. */
  private pendingRate: PendingRate | null = null;

  private readonly listeners = new Set<() => void>();
  private snapshot: YouTubePlayerState = { kind: "loading" };

  private readonly playheadListeners = new Set<() => void>();
  private playhead: number | null = null;
  private frame: number | null = null;

  // ── binding (called by <YouTubePlayer>) ────────────────────────────────────

  /** Record what should be shown; applied now if the player is ready. */
  setSource(source: YouTubeSource): void {
    const previous = this.source;
    this.source = source;
    const a = this.attached;
    if (a === null || !a.ready) return;
    if (
      previous === null ||
      previous.videoId !== source.videoId ||
      a.videoId !== source.videoId
    ) {
      this.load(a, source);
      return;
    }
    if (!sameRange(previous.loop, source.loop)) this.applyLoopChange(a);
    if (!sameAudio(previous.audio, source.audio)) this.applyAudio(a);
  }

  setCallbacks(read: () => YouTubePlayerCallbacks): void {
    this.callbacks = read;
  }

  /**
   * Create the YouTube player in `element` (which the API replaces with its
   * iframe). `controls` shows YouTube's own bar — for a video the viewer plays
   * by hand rather than one the app drives.
   */
  attach(
    yt: YTNamespace,
    element: HTMLElement,
    { controls }: { controls: boolean },
  ): void {
    if (this.attached !== null) {
      throw new Error("YouTubePlayerController is already bound to a player");
    }
    const player = new yt.Player(element, {
      width: "100%",
      height: "100%",
      playerVars: {
        // By default the app owns play / pause / seek; YouTube's own bar
        // would let the viewer wander out of the loop the app is keeping.
        controls: controls ? 1 : 0,
        // The iframe's keyboard shortcuts would fight the host app's.
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          const a = this.attached;
          if (a === null) return;
          a.ready = true;
          a.player.getIframe().style.display = "block";
          this.applyAudio(a);
          if (this.source !== null) this.load(a, this.source);
          else this.emit();
        },
        onStateChange: (event) => this.onStateChange(event.data),
        onError: (event) => this.onError(event.data),
        onPlaybackRateChange: (event) => {
          this.rearm();
          this.settleRate(event.data);
        },
      },
    });
    this.attached = {
      player,
      codes: yt.PlayerState,
      ready: false,
      videoId: null,
      duration: null,
      readyAnnounced: false,
      playingAnnounced: false,
      error: null,
      playing: false,
      advancing: false,
      cueInFlight: false,
      playSent: false,
      cuedAt: 0,
      held: null,
      anchor: null,
    };
    this.emit();
  }

  /** Destroy the player; the controller goes back to `loading`. */
  detach(): void {
    const a = this.attached;
    this.clearBoundary();
    this.stopFrames();
    this.attached = null;
    this.pass = null;
    this.pendingRate = null;
    this.playhead = null;
    a?.player.destroy();
    this.emit();
    this.notifyPlayhead();
  }

  // ── controller API ─────────────────────────────────────────────────────────

  get isPlaying(): boolean {
    return this.attached?.playing ?? false;
  }

  get isAdvancing(): boolean {
    return this.attached?.advancing ?? false;
  }

  play(): void {
    const a = this.requireReady("play");
    const loop = this.source?.loop ?? null;
    if (this.pass === null && loop !== null) {
      const t = this.mediaTime(a);
      if (t < loop.start || t >= loop.end - BOUNDARY_EPSILON_S) {
        this.seekPlayer(a, loop.start);
      }
    }
    // An unstarted video with a cue in flight plays once the cue lands: a
    // play sent now can be undone by it (the video lands cued, not playing).
    if (a.cueInFlight && this.unstarted(a)) {
      a.held = { seconds: a.held?.seconds ?? null, play: true };
      return;
    }
    a.playSent = true;
    a.player.playVideo();
  }

  pause(): void {
    const a = this.requireReady("pause");
    this.clearBoundary();
    if (a.held !== null) a.held = { ...a.held, play: false };
    a.playSent = false;
    a.player.pauseVideo();
  }

  playRange(start: number, end: number): void {
    const a = this.requireReady("playRange");
    if (!(end > start)) {
      throw new Error(`playRange: end (${end}) must be after start (${start})`);
    }
    this.pass = { start, end };
    this.seekPlayer(a, start);
    a.player.playVideo();
  }

  seek(seconds: number): void {
    const a = this.requireReady("seek");
    this.pass = null;
    this.seekPlayer(a, seconds);
  }

  getCurrentTime(): number {
    return this.mediaTime(this.requireReady("getCurrentTime"));
  }

  getDuration(): number | null {
    return this.requireReady("getDuration").duration;
  }

  getPlaybackRate(): number {
    return this.requireReady("getPlaybackRate").player.getPlaybackRate() || 1;
  }

  setPlaybackRate(rate: number): Promise<number> {
    const a = this.requireReady("setPlaybackRate");
    const playing = a.player.getPlaybackRate() || 1;
    if (this.pendingRate === null && rate === playing) {
      return Promise.resolve(playing);
    }
    const pending = this.pendingRateRequest(rate);
    const available = a.player.getAvailablePlaybackRates();
    // Before the video has played it lists no rates: hold the request, and
    // send it when the video first plays (`applyHeldRate`).
    if (available === undefined) {
      pending.target = null;
      return pending.promise;
    }
    this.sendRate(a, pending, available);
    return pending.promise;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): YouTubePlayerState => this.snapshot;

  subscribePlayhead = (listener: () => void): (() => void) => {
    this.playheadListeners.add(listener);
    this.readPlayhead();
    this.syncFrames();
    return () => {
      this.playheadListeners.delete(listener);
      this.syncFrames();
    };
  };

  getPlayhead = (): number | null => this.playhead;

  // ── internals ──────────────────────────────────────────────────────────────

  private requireReady(method: string): Attached {
    const a = this.attached;
    if (a === null || !a.ready) throw new YouTubePlayerNotReadyError(method);
    return a;
  }

  private load(a: Attached, source: YouTubeSource): void {
    this.clearBoundary();
    this.pass = null;
    a.videoId = source.videoId;
    a.duration = null;
    a.readyAnnounced = false;
    a.playingAnnounced = false;
    a.error = null;
    a.playing = false;
    a.advancing = false;
    a.held = null;
    a.playSent = false;
    a.anchor = null;
    const request = {
      videoId: source.videoId,
      startSeconds: source.loop?.start ?? 0,
    };
    if (source.autoplay) {
      a.cueInFlight = false;
      a.player.loadVideoById(request);
    } else this.cue(a, request.startSeconds);
    // Re-stated on every load: the level is the app's, not the video's.
    this.applyAudio(a);
    this.emit();
  }

  /** Set the player's volume and mute to the source's. A no-op without one. */
  private applyAudio(a: Attached): void {
    const audio = this.source?.audio ?? null;
    if (audio === null) return;
    a.player.setVolume(Math.min(100, Math.max(0, audio.volume)));
    if (audio.muted) a.player.mute();
    else a.player.unMute();
  }

  /** The loop moved on the same video: bring the playhead into it if needed. */
  private applyLoopChange(a: Attached): void {
    const loop = this.source?.loop ?? null;
    if (this.pass === null && loop !== null && a.playing) {
      const t = this.mediaTime(a);
      if (t < loop.start || t >= loop.end) {
        this.seekPlayer(a, loop.start);
        return;
      }
    }
    this.rearm();
  }

  private onStateChange(code: number): void {
    const a = this.attached;
    if (a === null) return;
    const { codes } = a;
    this.clearBoundary();
    // Pin the time as of now under the OLD state before `advancing` flips, so
    // a resume does not extrapolate across the pause.
    const pinned = this.mediaTime(a);
    if (a.anchor !== null) {
      a.anchor = { raw: a.anchor.raw, media: pinned, wall: performance.now() };
    }
    // A play of a cued video can pass UNSTARTED again after BUFFERING on its
    // way to PLAYING: still starting, not a stop.
    a.playing =
      code === codes.PLAYING ||
      code === codes.BUFFERING ||
      (code === codes.UNSTARTED && a.playSent);
    a.advancing = code === codes.PLAYING;
    this.refreshDuration(a);
    if (a.cueInFlight && code !== codes.UNSTARTED) {
      a.cueInFlight = false;
      this.releaseHeld(a);
    }

    if (code === codes.PLAYING) {
      this.applyHeldRate(a);
      if (!a.playingAnnounced) {
        a.playingAnnounced = true;
        this.callbacks().onPlaying?.();
      }
      this.armFrom(a, this.mediaTime(a));
    } else if (code === codes.ENDED && this.activeRange() !== null) {
      // The video ended before the boundary did (a loop end rounded past the
      // duration): treat it as the boundary.
      this.boundaryReached(a);
    }

    const name = STATE_NAMES[code];
    if (name !== undefined) this.callbacks().onStateChange?.(name);
    this.emit();
    this.readPlayhead();
    this.syncFrames();
  }

  private onError(code: number): void {
    const a = this.attached;
    if (a === null) return;
    this.clearBoundary();
    a.error = code;
    a.playing = false;
    a.advancing = false;
    this.callbacks().onError?.(code);
    this.emit();
    this.syncFrames();
  }

  private refreshDuration(a: Attached): void {
    if (a.duration !== null) return;
    const d = a.player.getDuration();
    if (!(d > 0)) return;
    a.duration = d;
    if (!a.readyAnnounced) {
      a.readyAnnounced = true;
      this.callbacks().onReady?.(d);
    }
  }

  /** The pass in progress, else the loop. */
  private activeRange(): YouTubeRange | null {
    return this.pass ?? this.source?.loop ?? null;
  }

  /** The request in flight, now asking for `rate` (one shared promise). */
  private pendingRateRequest(rate: number): PendingRate {
    if (this.pendingRate !== null) {
      this.pendingRate.requested = rate;
      return this.pendingRate;
    }
    let resolve: (rate: number) => void = () => {};
    const promise = new Promise<number>((r) => {
      resolve = r;
    });
    this.pendingRate = { target: null, requested: rate, promise, resolve };
    return this.pendingRate;
  }

  /** Snap the request onto the listed rates and send it (or settle it at once when nothing changes). */
  private sendRate(
    a: Attached,
    pending: PendingRate,
    available: readonly number[],
  ): void {
    const playing = a.player.getPlaybackRate() || 1;
    const target = snapPlaybackRate(
      pending.requested,
      pending.target ?? playing,
      available,
    );
    if (target === playing && pending.target === null) {
      this.pendingRate = null;
      pending.resolve(playing);
      return;
    }
    pending.target = target;
    a.player.setPlaybackRate(target);
  }

  /** The video plays: send a rate request held until it listed its rates. */
  private applyHeldRate(a: Attached): void {
    const pending = this.pendingRate;
    if (pending === null || pending.target !== null) return;
    const available = a.player.getAvailablePlaybackRates();
    if (available === undefined) return;
    this.sendRate(a, pending, available);
  }

  /** The player reported a new rate: settle the request it was the answer to. */
  private settleRate(rate: number): void {
    const pending = this.pendingRate;
    if (pending === null || rate !== pending.target) return;
    this.pendingRate = null;
    pending.resolve(rate);
  }

  /**
   * Seek, and re-arm from the target (a seek within the buffer may emit no
   * state change). A video that has not started (cued, or loaded without
   * autoplay) would START on `seekTo`, so it is re-cued at the time instead:
   * a seek never plays. "Not started" is this controller's own record (no
   * PLAYING since the load), not `getPlayerState()`: right after a load the
   * iframe has not reported the cue yet, and a `seekTo` sent then lands on a
   * player with no video — YouTube answers error 2.
   */
  private seekPlayer(a: Attached, seconds: number): void {
    if (this.unstarted(a) && a.videoId !== null) {
      if (a.cueInFlight) a.held = { seconds, play: a.held?.play ?? false };
      else this.cue(a, seconds);
    } else {
      a.player.seekTo(seconds, true);
    }
    // Until the iframe reports a new time, the seek target is the time.
    a.anchor = {
      raw: a.player.getCurrentTime(),
      media: seconds,
      wall: performance.now(),
    };
    this.clearBoundary();
    if (a.playing) this.armFrom(a, seconds);
    this.readPlayhead(seconds);
  }

  /** Cue the video at `seconds`; commands to it are held until the iframe reports it. */
  private cue(a: Attached, seconds: number): void {
    if (a.videoId === null) return;
    a.cueInFlight = true;
    a.cuedAt = seconds;
    a.player.cueVideoById({ videoId: a.videoId, startSeconds: seconds });
  }

  /** The cue landed: send what was asked meanwhile, in order — a re-cue at a new time first (held again), then the play. */
  private releaseHeld(a: Attached): void {
    const held = a.held;
    a.held = null;
    if (held === null) return;
    if (
      held.seconds !== null &&
      Math.abs(held.seconds - a.cuedAt) > BOUNDARY_EPSILON_S
    ) {
      this.cue(a, held.seconds);
      if (held.play) a.held = { seconds: null, play: true };
      return;
    }
    if (held.play) {
      a.playSent = true;
      a.player.playVideo();
    }
  }

  /**
   * Cued, or loaded without autoplay and not played since (the controller's
   * own record) — and no play on its way: a video asked to play is starting,
   * and re-cueing it would stop it.
   */
  private unstarted(a: Attached): boolean {
    if (a.playSent) return false;
    return (
      a.player.getPlayerState() === a.codes.CUED ||
      (!a.playingAnnounced && !(this.source?.autoplay ?? false))
    );
  }

  private rearm(): void {
    const a = this.attached;
    this.clearBoundary();
    if (a === null || !a.ready || !a.playing) return;
    this.armFrom(a, this.mediaTime(a));
  }

  /**
   * The one timer: set for the media time left until the active range's end,
   * scaled by the playback rate. No timer without a range.
   */
  private armFrom(a: Attached, currentTime: number): void {
    this.clearBoundary();
    const range = this.activeRange();
    if (range === null) return;
    const rate = a.player.getPlaybackRate() || 1;
    const ms = Math.max(
      MIN_REARM_MS,
      ((range.end - currentTime) / rate) * 1000,
    );
    this.boundaryTimer = setTimeout(() => {
      this.boundaryTimer = null;
      this.onBoundaryTimer();
    }, ms);
  }

  private onBoundaryTimer(): void {
    const a = this.attached;
    const range = this.activeRange();
    if (a === null || range === null || !a.playing) return;
    const t = this.mediaTime(a);
    if (t >= range.end - BOUNDARY_EPSILON_S) this.boundaryReached(a);
    // Not there yet (a stall the player did not report): set a new timer.
    else this.armFrom(a, t);
  }

  private boundaryReached(a: Attached): void {
    this.pass = null;
    const loop = this.source?.loop ?? null;
    if (loop === null) {
      a.player.pauseVideo();
      return;
    }
    this.seekPlayer(a, loop.start);
    a.player.playVideo();
  }

  /** The current media time: the player's last report, extrapolated while advancing. */
  private mediaTime(a: Attached): number {
    const raw = a.player.getCurrentTime();
    const now = performance.now();
    if (a.anchor === null || a.anchor.raw !== raw) {
      a.anchor = { raw, media: raw, wall: now };
    }
    if (!a.advancing) return a.anchor.media;
    const rate = a.player.getPlaybackRate() || 1;
    const ahead = Math.min(
      MAX_EXTRAPOLATION_S,
      ((now - a.anchor.wall) / 1000) * rate,
    );
    return a.anchor.media + ahead;
  }

  private clearBoundary(): void {
    if (this.boundaryTimer !== null) {
      clearTimeout(this.boundaryTimer);
      this.boundaryTimer = null;
    }
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const listener of this.listeners) listener();
  }

  private computeSnapshot(): YouTubePlayerState {
    const a = this.attached;
    if (a === null || !a.ready || a.videoId === null)
      return { kind: "loading" };
    if (a.error !== null) {
      return { kind: "error", videoId: a.videoId, code: a.error };
    }
    const prev = this.snapshot;
    if (
      prev.kind === "ready" &&
      prev.videoId === a.videoId &&
      prev.playing === a.playing &&
      prev.started === a.playingAnnounced &&
      prev.duration === a.duration
    ) {
      return prev;
    }
    return {
      kind: "ready",
      videoId: a.videoId,
      playing: a.playing,
      started: a.playingAnnounced,
      duration: a.duration,
    };
  }

  // ── playhead: one read per animation frame while playing and watched ──────

  private readPlayhead(known?: number): void {
    const a = this.attached;
    const next = a === null || !a.ready ? null : (known ?? this.mediaTime(a));
    if (next === this.playhead) return;
    this.playhead = next;
    this.notifyPlayhead();
  }

  private notifyPlayhead(): void {
    for (const listener of this.playheadListeners) listener();
  }

  private syncFrames(): void {
    const want =
      this.playheadListeners.size > 0 && (this.attached?.advancing ?? false);
    if (want && this.frame === null) {
      const tick = () => {
        this.readPlayhead();
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    } else if (!want) {
      this.stopFrames();
    }
  }

  private stopFrames(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}

function sameAudio(a: YouTubeAudio | null, b: YouTubeAudio | null): boolean {
  if (a === null || b === null) return a === b;
  return a.volume === b.volume && a.muted === b.muted;
}

function sameRange(a: YouTubeRange | null, b: YouTubeRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}
