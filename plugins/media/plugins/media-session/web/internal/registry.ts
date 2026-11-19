import { playMedia } from "@plugins/primitives/plugins/dom/plugins/media-element/web";
import { silenceUrl } from "./silence";

/**
 * What a claim tells the browser's media session, resolved (artwork as URLs).
 * Times are seconds at playback rate 1.
 */
export interface ResolvedClaim {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artwork: readonly MediaImage[];
  readonly playing: boolean;
  readonly position: MediaPosition | null;
  readonly actions: MediaSessionActions;
}

export interface MediaPosition {
  /** The whole length, in seconds. */
  readonly duration: number;
  /** Where playback is, in seconds. */
  readonly position: number;
}

/** What the browser's controls (and the OS media keys) may ask of the owner. */
export interface MediaSessionActions {
  readonly play: () => void;
  readonly pause: () => void;
  readonly stop?: () => void;
  /** Seek to `seconds` from the start. */
  readonly seekto?: (seconds: number) => void;
  /** Seek back by `offset` seconds (the browser's default when it gives none). */
  readonly seekbackward?: (offset: number) => void;
  /** Seek forward by `offset` seconds. */
  readonly seekforward?: (offset: number) => void;
}

const ACTIONS = [
  "play",
  "pause",
  "stop",
  "seekto",
  "seekbackward",
  "seekforward",
] as const satisfies readonly (keyof MediaSessionActions &
  MediaSessionAction)[];

/** Seconds a seek-backward / seek-forward moves when the browser names none. */
const DEFAULT_SEEK_OFFSET = 10;

interface Entry {
  claim: ResolvedClaim | null;
  /** When it last started playing (a counter); null: never played. */
  startedAt: number | null;
}

/**
 * The page's media-session claims. The browser has ONE media session per page,
 * so this is page-global: every `useMediaSession` caller registers here and the
 * claim that most recently started playing owns the session.
 */
const entries = new Map<symbol, Entry>();
let tick = 0;
let element: HTMLAudioElement | null = null;
let lastMetadata: string | null = null;
let lastPosition: string | null = null;

export function setClaim(key: symbol, claim: ResolvedClaim | null) {
  const entry = entries.get(key) ?? { claim: null, startedAt: null };
  const wasPlaying = entry.claim?.playing ?? false;
  entry.claim = claim;
  if (claim?.playing && !wasPlaying) entry.startedAt = ++tick;
  if (claim === null) entry.startedAt = null;
  entries.set(key, entry);
  apply();
}

export function dropClaim(key: symbol) {
  entries.delete(key);
  apply();
}

function owner(): ResolvedClaim | null {
  let best: Entry | null = null;
  for (const e of entries.values()) {
    if (e.claim === null || e.startedAt === null) continue;
    if (best === null || e.startedAt > (best.startedAt ?? 0)) best = e;
  }
  return best?.claim ?? null;
}

function apply() {
  const session = navigator.mediaSession;
  const claim = owner();
  syncElement(claim);
  if (claim === null) {
    if (lastMetadata !== null) session.metadata = null;
    lastMetadata = null;
    lastPosition = null;
    session.playbackState = "none";
    for (const action of ACTIONS) session.setActionHandler(action, null);
    return;
  }

  const metadata = JSON.stringify([
    claim.title,
    claim.artist,
    claim.album,
    claim.artwork,
  ]);
  if (metadata !== lastMetadata) {
    lastMetadata = metadata;
    session.metadata = new MediaMetadata({
      title: claim.title,
      artist: claim.artist,
      album: claim.album,
      artwork: [...claim.artwork],
    });
  }
  session.playbackState = claim.playing ? "playing" : "paused";

  for (const action of ACTIONS) {
    session.setActionHandler(
      action,
      claim.actions[action] === undefined ? null : handle,
    );
  }

  const position = positionState(claim.position);
  const positionKey = JSON.stringify(position);
  if (positionKey !== lastPosition) {
    lastPosition = positionKey;
    session.setPositionState(position);
  }
}

function positionState(
  p: MediaPosition | null,
): MediaPositionState | undefined {
  if (p === null || !Number.isFinite(p.duration) || p.duration <= 0) {
    return undefined;
  }
  return {
    duration: p.duration,
    position: Math.min(Math.max(p.position, 0), p.duration),
    // The browser extrapolates the scrubber at this rate while playbackState
    // is "playing" (a zero rate is refused: paused is said by the state).
    playbackRate: 1,
  };
}

/** Every browser action lands here and goes to the owner of the moment. */
function handle(details: MediaSessionActionDetails) {
  const actions = owner()?.actions;
  if (actions === undefined) return;
  switch (details.action) {
    case "play":
      actions.play();
      return;
    case "pause":
      actions.pause();
      return;
    case "stop":
      actions.stop?.();
      return;
    case "seekto":
      if (details.seekTime !== undefined) actions.seekto?.(details.seekTime);
      return;
    case "seekbackward":
      actions.seekbackward?.(details.seekOffset ?? DEFAULT_SEEK_OFFSET);
      return;
    case "seekforward":
      actions.seekforward?.(details.seekOffset ?? DEFAULT_SEEK_OFFSET);
      return;
    case "previoustrack":
    case "nexttrack":
    case "skipad":
      throw new Error(
        `media-session: no handler was registered for ${details.action}`,
      );
  }
}

/**
 * The keep-alive element: Chrome lists a page in its media controls only while
 * a media element plays in it, and Web Audio is not one. A near-silent loop
 * plays while the owner plays and pauses with it; with no owner its source is
 * dropped, so the browser forgets the session.
 */
function syncElement(claim: ResolvedClaim | null) {
  if (claim === null) {
    if (element !== null && element.hasAttribute("src")) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    return;
  }
  element ??= Object.assign(new Audio(), { loop: true, preload: "auto" });
  if (!element.hasAttribute("src")) element.src = silenceUrl();
  if (claim.playing) {
    if (element.paused) play(element);
  } else if (!element.paused) {
    element.pause();
  }
}

function play(el: HTMLAudioElement) {
  // A refusal (the autoplay policy: no gesture on this page yet; a pause or a
  // dropped src overtaking it) leaves it paused; the next change of the claim
  // (a press in the app) tries again. Only an unnamed rejection throws.
  void playMedia(el);
}
