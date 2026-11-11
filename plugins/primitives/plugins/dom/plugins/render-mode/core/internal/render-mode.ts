// ── Is this a live page, or one static render to HTML? ───────────────────────
//
// The app renders live in a browser almost always. A static-render process (the
// website's crawlable snapshot) renders it ONCE to HTML that is never hydrated:
// no click ever runs, so whatever a live control leaves to an event handler (a
// link's destination, computed at click time) must be written into the markup
// instead. A building block asks `renderMode()` and adds what a robot needs.
//
// Like a browser host's storage (`browser-server/host-storage`), the mode is a
// fact handed to the process at its entry: declared once, before any app module
// loads, and fixed from the first read on — a component that rendered "live"
// and a later one that renders "static" would disagree inside one page.

/** `live`: a page in a browser. `static`: one render to HTML, never hydrated. */
export type RenderMode = "live" | "static";

let declared: "static" | undefined;
let read = false;

/**
 * Declare this process a static render. Called ONCE, by the static-render
 * process's entry point, before it loads any app module. Throws on a second
 * declaration, and after anything has already read the mode (it would have
 * read "live").
 */
export function declareRenderMode(mode: "static"): void {
  if (declared !== undefined) {
    throw new Error(
      "[render-mode] declared twice — a static-render process declares its mode once, at its entry.",
    );
  }
  if (read) {
    throw new Error(
      '[render-mode] declared after the mode was already read (as "live") — declare it at the process\'s entry, before loading any app module.',
    );
  }
  declared = mode;
}

/** How this process renders the app: `"live"` unless a static render declared itself. */
export function renderMode(): RenderMode {
  read = true;
  return declared ?? "live";
}
