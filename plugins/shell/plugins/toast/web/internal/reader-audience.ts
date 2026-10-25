import { useEffect } from "react";
import { useAudience } from "@plugins/audience/web";
import { reachesAudience, type Audience } from "@plugins/audience/core";

/**
 * The audience of whoever reads this page's toasts, as last published by the
 * mounted `<ToasterHost/>` — `null` while it is not known (no host yet, or the
 * Developer mode setting still loading / unreadable).
 */
let reader: Audience | null = null;

/** The host publishes its reader's audience while mounted. */
export function usePublishReaderAudience(): void {
  const audience = useAudience();
  const known = audience.status === "ready" ? audience.data : null;
  useEffect(() => {
    reader = known;
  }, [known]);
}

/**
 * Whether a toast declared for `declared` is shown: a toast declaring no
 * audience (or `user`) is for everyone; a `developer` toast only once the
 * reader is known to be a developer — while that is not known, it is not
 * shown (a passing toast has nothing to wait for).
 */
export function toastReachesReader(declared: Audience | undefined): boolean {
  if (declared === undefined || declared === "user") return true;
  return reader !== null && reachesAudience(declared, reader);
}
