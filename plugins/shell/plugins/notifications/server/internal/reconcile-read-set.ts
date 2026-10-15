import { db } from "@plugins/database/server";
import { reconcileReadSetTable } from "@plugins/database/plugins/live-state-snapshot/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { notificationsServed, notificationsUnreadServed } from "./resources";

const log = defineLogSink({
  id: "notifications",
  description:
    "Notifications ops log: boot-time read-set reconciliation (stale live-state reader eviction).",
});

// The `notifications` table's only live-state readers are the resources the
// `notifications` collection mints (its window, `:rows` and `:groups`) and the
// bell's `notifications.unread` value — read from each served object's `keys`,
// so adding a sibling can never evict it.
// Assert that invariant on boot: evict any stale `notifications` edge that a
// past mis-attribution baked into another resource's read-set. The read-set
// index is append-only + persisted + re-seeded, so a historical
// mis-attribution never self-heals otherwise (see
// research/2026-07-07-global-read-set-notifications-attribution-noise.md). This is
// a durable guard — it also catches any future regression on the same table.
//
// Called from the plugin's onReady, which runs AFTER live-state-snapshot's
// onReadyBlocking seed (the onReadyBlocking barrier fully completes before any
// onReady), so the in-memory index is populated and the persisted column is safe
// to touch. Cosmetic cleanup: a failure is reported loudly but must NOT crash
// boot, mirroring live-state-snapshot's own graceful-degradation hooks.
export async function reconcileNotificationsReadSet(): Promise<void> {
  try {
    const changed = await reconcileReadSetTable(db, "notifications", [
      ...notificationsServed.keys,
      ...notificationsUnreadServed.keys,
    ]);
    if (changed > 0) {
      log.publish(
        `evicted stale 'notifications' read-set edge from ${changed} persisted resource read-set(s)`,
        "stdout",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[notifications] read-set reconciliation failed", msg);
    log.publish(`read-set reconciliation failed: ${msg}`, "stderr");
  }
}
