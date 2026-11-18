// ── The browser's element fullscreen, only where it exists ──────────────────
//
// `Element.requestFullscreen` is not on every browser: an iPhone has no element
// fullscreen at all (Safari there fullscreens a <video> only), and a frame
// without `allowfullscreen` has the method but may not use it. A caller that
// calls `el.requestFullscreen()` unchecked crashes there with "requestFullscreen
// is not a function" (equin.ai's Keyboard Party, Safari, 2026-11-18). So the
// request is reachable only through `fullscreenSupport(doc)`: its `unsupported`
// arm carries no `request`, so a caller must branch — and a control whose only
// job is fullscreen is not offered where the browser cannot do it.
//
// The `element-fullscreen/no-raw-request-fullscreen` lint rule sends every
// other `.requestFullscreen()` call here.

import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";

/** What this document can do about element fullscreen. */
export type FullscreenSupport =
  | {
      /** No element fullscreen here (iPhone, a frame without allowfullscreen). */
      kind: "unsupported";
    }
  | {
      kind: "supported";
      /**
       * Asks the browser to show `el` full screen. Still a request: it rejects
       * without a user activation — the caller decides what a refusal means.
       */
      request: (el: Element) => Promise<void>;
    };

const UNSUPPORTED: FullscreenSupport = { kind: "unsupported" };

/** One answer per document, so a render-time read is a stable value. */
const byDocument = new WeakMap<Document, FullscreenSupport>();

function detect(doc: Document): FullscreenSupport {
  // `fullscreenEnabled` is undefined on a browser without the API, false in a
  // frame that may not use it; the method check covers a browser that names
  // one and not the other.
  if (
    doc.fullscreenEnabled !== true ||
    typeof doc.documentElement.requestFullscreen !== "function"
  )
    return UNSUPPORTED;
  return {
    kind: "supported",
    request: (el) => el.requestFullscreen(),
  };
}

/** Whether `doc` (default: this page's) can show an element full screen, and how to ask. */
export function fullscreenSupport(doc: Document = document): FullscreenSupport {
  let support = byDocument.get(doc);
  if (support === undefined) {
    support = detect(doc);
    byDocument.set(doc, support);
  }
  return support;
}

const readSupport = (): FullscreenSupport => fullscreenSupport();

/**
 * {@link fullscreenSupport} of this page, for a component deciding whether to
 * offer a fullscreen control. A static render (no DOM) answers `unsupported`:
 * it never requests anything.
 */
export function useFullscreenSupport(): FullscreenSupport {
  return useBrowserValue({
    name: "document.fullscreenEnabled",
    read: readSupport,
    staticValue: UNSUPPORTED,
  });
}
