import { toggleMute, volumeTarget } from "./math";

/**
 * Every write the player makes to its media element, in one place. The
 * element is the one truth for what is playing (`useMediaState` reads it
 * back on its own events), so the components only ever ask it to change.
 */

/** Play, answering a refusal (no user gesture yet, or a pause cut it short) by staying paused. */
export function playMedia(el: HTMLMediaElement): void {
  el.play().catch((err: unknown) => {
    if (
      err instanceof DOMException &&
      (err.name === "NotAllowedError" || err.name === "AbortError")
    )
      return;
    throw err;
  });
}

export function togglePlayback(el: HTMLMediaElement): void {
  if (el.paused) playMedia(el);
  else el.pause();
}

export function seekMedia(el: HTMLMediaElement, time: number): void {
  el.currentTime = time;
}

/** A level: 0 mutes, anything else unmutes (clamped). */
export function setMediaVolume(el: HTMLMediaElement, v: number): void {
  const t = volumeTarget(v);
  el.volume = t.volume;
  el.muted = t.muted;
}

export function toggleMediaMute(el: HTMLMediaElement): void {
  const t = toggleMute(el.volume, el.muted);
  el.volume = t.volume;
  el.muted = t.muted;
}

/** The speed, kept across a reload of the source (`defaultPlaybackRate`). */
export function setMediaRate(el: HTMLMediaElement, rate: number): void {
  el.playbackRate = rate;
  el.defaultPlaybackRate = rate;
}

export function setMediaLoop(el: HTMLMediaElement, loop: boolean): void {
  el.loop = loop;
}

/** The class of the player's host element (live: the portal container; static: the same box in place). */
export const PLAYER_HOST_CLASS = "mp-host";

/** The element the player renders into: a portal container `MediaPlayer` moves between documents. */
export function createPlayerHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.className = PLAYER_HOST_CLASS;
  return host;
}

/** Put the player's host into `parent` (the page's slot, or a picture-in-picture body). */
export function placeHost(parent: Element | null, host: HTMLElement): void {
  parent?.append(host);
}

export function removeHost(host: HTMLElement): void {
  host.remove();
}
