import { useSyncExternalStore } from "react";

/**
 * The window Google's Maps script calls back on. A cast where it is used, not
 * a `Window` augmentation: a global declaration makes every edit to the file
 * holding it re-check the whole repo.
 */
type MapsAuthWindow = Window & {
  /**
   * Google's one signal that the browser key was refused (wrong HTTP
   * referrer, Maps JavaScript API not enabled, key deleted or billing off).
   * Without a handler the map just goes grey with a watermark.
   */
  gm_authFailure?: () => void;
};

/**
 * Whether Google has refused the key in THIS page. It is page-global state
 * because the Maps script is: it loads once per page with one key, and a
 * refusal stays true until the page reloads. A fixed key takes effect only
 * after a reload.
 */
// eslint-disable-next-line scoped-store/no-module-mutable-store -- the Maps script is loaded once per DOCUMENT with one key, so a refusal is a fact about the document: every surface's map must see it, and a per-surface store would let a second window mount a map that is already refused.
let refused = false;
const listeners = new Set<() => void>();
let installed = false;

/**
 * Installed on first subscribe, which is long before Google can call it: the
 * callback fires only after the script has loaded AND its auth check has come
 * back from the network. Chains to whatever handler was there before, so this
 * never swallows another listener.
 */
function install(): void {
  if (installed) return;
  installed = true;
  const w = window as MapsAuthWindow;
  const previous = w.gm_authFailure;
  w.gm_authFailure = () => {
    refused = true;
    for (const listener of listeners) listener();
    previous?.();
  };
}

function subscribe(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return refused;
}

/** True once Google has refused the browser key in this page. */
export function useGoogleAuthRefused(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
