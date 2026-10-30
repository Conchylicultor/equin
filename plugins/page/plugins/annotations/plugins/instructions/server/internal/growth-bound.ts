import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _pageInstructionsDeliveries } from "./tables";

/**
 * The deliveries table's growth bound: a nightly sweep of deliveries older than
 * 30 days, in every worktree's own DB (the table lives in the per-worktree fork).
 *
 * The `block_id` cascade reclaims rows whose block is purged, but the table also
 * grows with CONVERSATIONS, which nothing else bounds. Sweeping a delivery is
 * safe by construction: the only consequence is that a conversation still
 * running after 30 days is handed the same instructions again on its next read
 * under them — a repeat, never a missed delivery.
 */
export const instructionsDeliveriesRetention = defineRetention({
  table: _pageInstructionsDeliveries,
  column: "deliveredAt",
  ttlDays: 30,
  perWorktree: true,
});
