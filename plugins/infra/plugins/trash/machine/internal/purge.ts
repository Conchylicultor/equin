import { defineRetention } from "@plugins/infra/plugins/retention/server";
import {
  _trashEntries,
  getTrashSource,
} from "@plugins/infra/plugins/trash/server";
import type { TrashEntry } from "../../core/schemas";

// 30-day grace period, Notion-style: long enough to notice a bad delete, short
// enough to bound growth (the {kind:"ttl"} growth bound covers `trash_entries`
// AND, transitively, every source's soft-deleted domain rows — purge is where
// they are finally hard-deleted).
const TRASH_TTL_DAYS = 30;

/**
 * The nightly purge: `beforeDelete` runs each source's `purge` over its expired
 * entries (destroy hooks + hard-delete the domain roots — the FK cascades fire
 * here, intended), then the sweep deletes the ledger rows. `perWorktree`
 * because `trash_entries` (like the page data it references) lives in the
 * per-worktree DB fork. An unregistered source is a LOUD throw: the sweep
 * aborts, rows survive to the next tick, and the misconfiguration surfaces
 * instead of silently stranding unrestorable domain rows.
 */
export const trashPurge = defineRetention({
  table: _trashEntries,
  column: "deletedAt",
  ttlDays: TRASH_TTL_DAYS,
  perWorktree: true,
  beforeDelete: async (rows) => {
    const bySource = new Map<string, TrashEntry[]>();
    for (const entry of rows) {
      const group = bySource.get(entry.sourceId);
      if (group) group.push(entry);
      else bySource.set(entry.sourceId, [entry]);
    }
    for (const [sourceId, entries] of bySource) {
      const source = getTrashSource(sourceId);
      if (!source) {
        throw new Error(
          `[trash] purge: no trash source registered for "${sourceId}" — cannot destroy its ${entries.length} expired entr${entries.length === 1 ? "y" : "ies"}`,
        );
      }
      await source.purge(entries);
    }
  },
});
