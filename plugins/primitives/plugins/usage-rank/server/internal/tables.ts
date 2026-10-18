import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { usageStatsEntityRef } from "../../core/internal/schema";

/**
 * Generic (namespace, key) usage rollup — ONE row per tracked thing, no event
 * log. Works for any consumer: `namespace` names the domain (`prompt-templates`,
 * a command palette, …), `usage_key` is `${namespace}:${key}` (see `usageKey`
 * in core). Built from `usageStatFields` (core/internal/schema.ts).
 *
 * An entity with no parent table: an extension needs a parent table + FK, and
 * the things ranked here are config items / registry entries with no DB row to
 * hang off.
 *
 * The single-column text PK is load-bearing — it IS the `usageStats`
 * collection's row id, which the change-feed intersects against each
 * subscribed tuple's id set.
 *
 * `score` is the frecency score as of `last_used_at`, not as of now: the upsert
 * decays it to the write instant then adds 1, and every reader decays again to
 * its own now (`decayedScore`).
 */
export const usageStatsEntity = defineEntity(usageStatsEntityRef, {
  primaryKey: "usageKey",
  columns: {
    score: { default: 0 },
    useCount: { default: 0 },
  },
});

export const _usageStats = usageStatsEntity.table;
