import { index, uniqueIndex } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { reportsEntityRef } from "../../core/entity";

// One row per (fingerprint, worktree). Upserts atomically dedupe repeats:
// first report inserts + creates a task; repeats bump count and advance
// last_seen_at. See research/2026-04-21-global-crashes-plugin.md.
//
// `kind` discriminates the event type and is fully generic — the reports engine
// never names a kind. Each kind contributes a ReportKindSpec (schema +
// fingerprint + meta + renderTask) and stores its per-kind payload in the
// generic `data` jsonb column; the validated payload shape is owned by the
// kind, not this table. The columns are `reportFields` (core/entity.ts).
//
// `updatedAt` is DERIVED (derived-updated-at): it moves when what the report
// SAYS changes — its message, payload, count, velocity/noise flags, or the task
// filed for it. Sightings alone (`lastSeenAt`, the attribution columns) are
// their own facts and do not count. No write site stamps it.
const reportsEntity = defineEntity(reportsEntityRef, {
  primaryKey: "id",
  columns: {
    kind: { default: "crash" },
    data: { default: {} },
    count: { default: 1 },
    rateLimited: { default: false },
    noise: { default: false },
    firstSeenAt: { default: defaultNow() },
    lastSeenAt: { default: defaultNow() },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  updatedAt: {
    touchedBy: {
      kind: true,
      message: true,
      url: true,
      userAgent: true,
      data: true,
      count: true,
      rateLimited: true,
      noise: true,
      taskId: true,
      id: false,
      fingerprint: false,
      worktree: false,
      source: false,
      lastClientId: false,
      lastBuildId: false,
      firstSeenAt: false,
      lastSeenAt: false,
      createdAt: false,
    },
  },
  indexes: (t) => [
    uniqueIndex("reports_fingerprint_worktree_idx").on(
      t.fingerprint,
      t.worktree,
    ),
    index("reports_task_id_idx").on(t.taskId),
    // The Reports DataView's default order (last seen, newest first) with the
    // PK tiebreaker the `reports.list` window appends — see core/resources.ts.
    index("reports_last_seen_idx").on(t.lastSeenAt, t.id),
  ],
});

export const _reports = reportsEntity.table;
