// ── A media element's play(), with every refusal named ──────────────────────
//
// `HTMLMediaElement.play()` returns a promise that rejects with a bare
// DOMException — no stack, and on WebKit no message beyond its default ("The
// operation is not supported."). Most rejections are the browser answering, not
// a bug: no user gesture yet (NotAllowedError), a pause or a new source
// overtaking the play (AbortError), or a source that failed to load
// (NotSupportedError, with the element's `error` set and its `error` event —
// the player's onError — already reporting it). A caller that rethrew those
// filed a stack-less crash for each (equin.ai's hero film on iPhone Safari,
// report-1795099021-lq0l6y, 2026-11-19).
//
// So `playMedia` answers what happened as a value, and only a rejection it
// cannot name throws — a MediaPlayError carrying the caller's stack, the
// element's state and the DOMException as its cause. The
// `media-element/no-raw-media-play` lint rule sends every other `.play()`
// whose promise is used here.

/** What became of a play request the browser answered. */
export type PlayOutcome =
  | { kind: "playing" }
  /** No user activation yet (the autoplay policy): the element stays paused. */
  | { kind: "refused"; reason: "no-gesture" }
  /** A pause(), a load() or a new src overtook the play. */
  | { kind: "refused"; reason: "overtaken" }
  /**
   * The source could not be loaded or decoded: the element's `error` (the same
   * one its `error` event reports, so the caller's onError already saw it).
   */
  | { kind: "refused"; reason: "source-failed"; error: MediaError };

/** A play() rejection that is none of the browser's known answers. */
export class MediaPlayError extends Error {
  override name = "MediaPlayError";
}

function describeElement(el: HTMLMediaElement): string {
  const err = el.error;
  return [
    `<${el.tagName.toLowerCase()}> src=${el.currentSrc || el.getAttribute("src") || "(none)"}`,
    `readyState=${el.readyState}`,
    `networkState=${el.networkState}`,
    `error=${err === null ? "none" : `${err.code}${err.message ? ` (${err.message})` : ""}`}`,
  ].join(" ");
}

/** The rejection as an outcome, or null when it is none of the known answers. */
export function playRefusal(
  el: HTMLMediaElement,
  err: unknown,
): PlayOutcome | null {
  if (!(err instanceof DOMException)) return null;
  if (err.name === "NotAllowedError")
    return { kind: "refused", reason: "no-gesture" };
  if (err.name === "AbortError")
    return { kind: "refused", reason: "overtaken" };
  // Per the HTML spec, play() rejects with NotSupportedError exactly when the
  // source failed — which sets `el.error` and fires `error`. Without an error
  // on the element it is not that, and is not swallowed.
  if (err.name === "NotSupportedError" && el.error !== null)
    return { kind: "refused", reason: "source-failed", error: el.error };
  return null;
}

/**
 * Asks `el` to play. Resolves with what the browser answered; rejects only with
 * a {@link MediaPlayError} (the caller's stack, the element's state, the
 * original rejection as `cause`) when the rejection is none of them.
 */
export async function playMedia(el: HTMLMediaElement): Promise<PlayOutcome> {
  // Made before the await, so its stack is the caller's — the DOMException
  // the browser rejects with has none.
  const origin = new MediaPlayError("media play() rejected");
  try {
    await el.play();
    return { kind: "playing" };
  } catch (err) {
    const refusal = playRefusal(el, err);
    if (refusal !== null) return refusal;
    const what =
      err instanceof DOMException ? `${err.name}: ${err.message}` : String(err);
    origin.message = `media play() rejected with ${what} — ${describeElement(el)}`;
    origin.cause = err;
    throw origin;
  }
}
