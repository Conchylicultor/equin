/**
 * Whether the visitor could see this page load, from its navigation's start
 * until now — the question every load timing must ask before it means
 * anything: a browser does not paint a tab no one is looking at, so a paint
 * that waited for the tab to be shown measures the visitor, not the load.
 *
 * A reader that mounts with the app (seconds into a slow load) cannot answer
 * it from what it sees then: the page may have been hidden and shown again
 * before it ran, or hidden before it subscribed to `visibilitychange`. So the
 * answer is read from records that start with the page:
 *
 * - the page shell's inline record (`framework/web-core`'s `index.html`): the
 *   first instant the document was not visible, kept on
 *   {@link FIRST_HIDDEN_GLOBAL} by a listener installed while the head parses
 *   — every browser;
 * - Chromium's `visibility-state` performance entries, which start at the
 *   navigation itself (so a hide before the shell's script ran is known too);
 * - prerendering: a page loaded before anyone asked for it (Chrome's omnibox
 *   or speculation rules) is shown only at its activation — every milestone
 *   before that is no one's wait.
 */

/**
 * The global the page shell's inline script records the first hide on
 * (`performance.now()` ms, set once), read by {@link pageShown}'s web reader.
 * Absent while the page has been visible since the head parsed.
 */
export const FIRST_HIDDEN_GLOBAL = "__equinFirstHiddenAt";

/** Whether the visitor could see the page load since its navigation started. */
export type PageShown =
  /** Visible from the navigation's start until now. */
  | { kind: "shown" }
  /** First not visible `atMs` after the navigation's start (0 = opened in the background). */
  | { kind: "hidden"; atMs: number }
  /** Loaded before it was shown (prerendered): no milestone of it was waited for. */
  | { kind: "prerendered" };

/** What the browser keeps about the page's visibility (the web reader fills it). */
export interface PageShownRecords {
  /** `document.prerendering`: still prerendering now. */
  prerendering: boolean;
  /** The navigation's `activationStart`: > 0 once a prerendered page was shown. */
  activationStartMs: number;
  /** Chromium's `visibility-state` entries (empty elsewhere). */
  visibilityEntries: readonly { name: string; startTime: number }[];
  /** The shell's inline record ({@link FIRST_HIDDEN_GLOBAL}), null when unset. */
  recordedFirstHiddenMs: number | null;
  /** The document is not visible now. */
  hiddenNow: boolean;
  /** `performance.now()`. */
  nowMs: number;
}

/** The earliest instant any record says the page was not visible. PURE. */
export function pageShown(r: PageShownRecords): PageShown {
  if (r.prerendering || r.activationStartMs > 0) return { kind: "prerendered" };
  let at = Infinity;
  for (const e of r.visibilityEntries) {
    if (e.name === "hidden") at = Math.min(at, e.startTime);
  }
  if (r.recordedFirstHiddenMs !== null) {
    at = Math.min(at, r.recordedFirstHiddenMs);
  }
  if (r.hiddenNow) at = Math.min(at, r.nowMs);
  return at === Infinity
    ? { kind: "shown" }
    : { kind: "hidden", atMs: Math.max(0, at) };
}

/**
 * The instant from which the page's milestones are no longer the load's:
 * the first hide, 0 for a prerendered page, null while it has been shown
 * throughout. A milestone at or after it was reached only because the
 * visitor came back. PURE.
 */
export function notShownFromMs(shown: PageShown): number | null {
  switch (shown.kind) {
    case "shown":
      return null;
    case "hidden":
      return shown.atMs;
    case "prerendered":
      return 0;
  }
}
