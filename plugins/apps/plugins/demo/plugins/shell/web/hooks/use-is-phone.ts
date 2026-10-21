import { useSyncExternalStore } from "react";

/** A phone: a touch-first screen narrower than a tablet. Both halves, so a
 *  narrow desktop window or a touch laptop still gets the demo. */
const PHONE_QUERY = "(pointer: coarse) and (max-width: 767px)";

function subscribe(callback: () => void) {
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.matchMedia(PHONE_QUERY).matches;
}

/** Whether the page is on a phone — read synchronously on first render, so a
 *  phone never mounts what this gates. */
export function useIsPhone() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
