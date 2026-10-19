import { readEmbedMode, withEmbedFlag, type EmbedMode } from "../../core";

// `null` = read, and this document is not embedded; `undefined` = not read yet.
let resolved: EmbedMode | null | undefined;

/**
 * How THIS document is embedded, or `undefined` when it is not.
 *
 * Read ONCE, on first call, and memoized for the document's lifetime — never
 * re-read from the URL later. The pane store rebuilds every URL it writes from
 * the route alone (`buildRouteUrl` + `applyBasePath` in `primitives/pane`), so
 * no query survives the first in-frame click; a live read would drop the flag
 * and bring the chrome back mid-session. The flag is a fact about how this
 * document was OPENED, and that is what is captured.
 */
export function embedMode(): EmbedMode | undefined {
  resolved ??=
    typeof window === "undefined"
      ? null
      : (readEmbedMode(window.location.search) ?? null);
  return resolved ?? undefined;
}

/**
 * Is THIS document embedded at all, in either mode? The question for anything
 * about being hosted on the same origin: storage the host tab owns, framing
 * the app again from inside a frame.
 */
export function isEmbeddedDocument(): boolean {
  return embedMode() !== undefined;
}

/**
 * Is THIS document embedded WITHOUT its app chrome? The question for the
 * chrome itself — the tab bar, the app rail, the floating action bar. An embed
 * in `chrome` mode draws all three.
 */
export function isChromelessDocument(): boolean {
  return embedMode() === "chromeless";
}

/**
 * Is THIS document loaded inside a frame (an iframe of another page)? Not the
 * same question as {@link isEmbeddedDocument}: a chromeless page opened in a
 * browser tab of its own carries the flag but is the top of its window. The
 * question for anything that must not nest the app inside itself.
 */
export function isFramedDocument(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

/** An in-app URL (`/agents/c/1`, query allowed) that opens embedded in `mode`. */
export function embedUrl(path: string, mode: EmbedMode): string {
  return withEmbedFlag(path, window.location.origin, mode);
}

/** Drop the memoized read between tests (mirrors resetAppInstanceForTests). */
export function resetEmbedForTests(): void {
  resolved = undefined;
}
