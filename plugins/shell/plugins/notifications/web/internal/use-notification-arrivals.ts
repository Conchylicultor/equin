import { useEffect, useRef } from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { Notification } from "../../shared/resources";
import { useReachingNotifications } from "./use-reaching-notifications";
import { recentClientIds } from "./toast";

/**
 * Calls `onArrive` once for each notification that ARRIVES while the caller is
 * mounted — pushed live by the `notifications` collection, never polled. The
 * rows already there when the read first settles are history and are never
 * announced; a resurfaced row keeps its id and is not announced again. Rows
 * this page raised itself (its own toasts, already on screen) and muted rows
 * are skipped, and only rows that reach the user's audience are read at all.
 *
 * The one statement of "a new notification just came in": the bell's toasts
 * and the menu-bar panel's native notifications both read it.
 */
export function useNotificationArrivals(
  onArrive: (notification: Notification) => void,
): void {
  const result = useReachingNotifications();
  const seen = useRef<Set<string> | null>(null);
  const arrive = useEventCallback(onArrive);
  useEffect(() => {
    if (result.status === "loading" || result.status === "error") return;
    const rows = result.data;
    const before = seen.current;
    if (before !== null) {
      for (const n of rows) {
        if (!before.has(n.id) && !recentClientIds.has(n.id) && !n.muted) {
          arrive(n);
        }
      }
    }
    seen.current = new Set(rows.map((n) => n.id));
  }, [result, arrive]);
}
