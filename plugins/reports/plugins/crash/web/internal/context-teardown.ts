// A promise the browser itself rejected because the document is being torn
// down — not something the page did wrong.
//
// WebKit, when a document or worker goes away (a navigation, a reload, a closed
// tab, a frame removed), runs `WebLockManager::clientIsGoingAway()`: every
// pending or held Web Lock's promise (`navigator.locks.request`, `.query`) is
// rejected with
//   AbortError: Promise was rejected because the browsing context is going away
// and `Permissions::query` does the same. A lock held for the page's lifetime
// (tab presence, a browser-server port's presence, the demo's visitor lock, the
// stall watchdog's tab lock) is released exactly that way, so every Safari
// page leaving rejected one, unhandled and stackless (equin.ai, 2026-11-18
// 20:17 UTC onwards: report-1795034221-v9b6g9, 26 occurrences on /, /demo/).
// Chromium and Firefox drop those promises instead.
//
// The words are WebKit's own (Source/WebCore/Modules/web-locks/
// WebLockManager.cpp, Modules/permissions/Permissions.cpp), a closed,
// browser-owned signal like a fetch's "Load failed": no page code throws it,
// and it says the page is leaving — which no code of ours can act on.
// Only that exact message is recognised: any other AbortError (an aborted
// fetch, a lock request's own signal) is still filed.

const TEARDOWN_MESSAGE =
  "Promise was rejected because the browsing context is going away";

/** Whether `err` is WebKit rejecting a promise because its document is going away. */
export function isContextTeardown(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    err.name === "AbortError" &&
    err.message === TEARDOWN_MESSAGE
  );
}
