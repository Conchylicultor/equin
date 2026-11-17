import { useEffect, useSyncExternalStore } from "react";
import {
  holdReload,
  readReloadReadiness,
  subscribeReloadReadiness,
  type ReloadReadiness,
} from "./readiness-store";

/**
 * Hold the page while `active`: a running process this component owns
 * (playback, a long operation) that a reload would stop. Released when
 * `active` turns false or the component unmounts.
 */
export function useReloadHold(
  active: boolean,
  { label }: { label: string },
): void {
  useEffect(() => {
    if (!active) return;
    return holdReload(label);
  }, [active, label]);
}

/** The page's reload readiness — holds, engagement, visibility — read live. */
export function useReloadReadiness(): ReloadReadiness {
  return useSyncExternalStore(
    subscribeReloadReadiness,
    readReloadReadiness,
    readReloadReadiness,
  );
}
