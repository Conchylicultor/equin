import { useEffect, useRef } from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useAudience } from "@plugins/audience/web";
import type { Audience } from "@plugins/audience/core";
import type { Notification } from "../../shared/resources";
import { useReachingNotifications } from "./use-reaching-notifications";
import { recentClientIds } from "./toast";

/**
 * Calls `onArrive` once for each notification that ARRIVES while the caller is
 * mounted — pushed live by the `notifications` collection, never polled. The
 * rows already there when the read first settles are history and are never
 * announced; a resurfaced row keeps its id and is not announced again. Rows
 * this page raised itself (its own toasts, already on screen) and muted rows
 * are skipped, and so is a toast ANOTHER tab raised unless it is a failure
 * (`announcedElsewhere`) — a confirmation or a tab's own observation (Copied,
 * Reconnected) answers that tab, not this one; and only rows that reach the user's audience are read at all.
 * A change of audience (Developer mode switched on) starts the history over:
 * the rows it newly reaches were already there, not arrivals.
 *
 * The one statement of "a new notification just came in": the bell's toasts
 * and the menu-bar panel's native notifications both read it.
 */
export function useNotificationArrivals(
  onArrive: (notification: Notification) => void,
): void {
  const result = useReachingNotifications();
  const audience = useAudience();
  const seen = useRef<{ audience: Audience; ids: Set<string> } | null>(null);
  const arrive = useEventCallback(onArrive);
  useEffect(() => {
    if (result.status === "loading" || result.status === "error") return;
    if (audience.status !== "ready") return;
    const rows = result.data;
    const before =
      seen.current?.audience === audience.data ? seen.current.ids : null;
    if (before !== null) {
      for (const n of rows) {
        if (
          !before.has(n.id) &&
          !recentClientIds.has(n.id) &&
          !n.muted &&
          announcedElsewhere(n)
        ) {
          arrive(n);
        }
      }
    }
    seen.current = {
      audience: audience.data,
      ids: new Set(rows.map((n) => n.id)),
    };
  }, [result, audience, arrive]);
}

/**
 * Whether a row reaches other tabs as an arrival: one the server wrote always
 * does; one a browser tab wrote (`metadata.clientId`, stamped by `useToast`)
 * only when it is a failure — what went wrong in a tab the user is not looking
 * at should find them, but a tab's confirmations and observations ("Copied",
 * "Reconnected") stay that tab's toast, recorded in the bell.
 */
function announcedElsewhere(n: Notification): boolean {
  if (typeof n.metadata?.clientId !== "string") return true;
  return n.variant === "error" || n.variant === "warning";
}
