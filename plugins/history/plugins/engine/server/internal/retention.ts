import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _entityVersions } from "./tables";

// `entity_versions` is an unbounded-growth firehose: one row accrues per edit of
// a versioned entity. `recordVersion` coalesces edits inside a ~10-min window
// onto a single row, so growth is bounded per session — but the row count over
// time is not. The table has NO FK to any consumer (deliberately: the engine is
// domain-agnostic and the snapshot is opaque), so the only reclamation path today
// is the consumer calling `deleteVersions` on entity delete. A live,
// frequently-edited page therefore grows its history forever.
//
// 30-day TTL: unlike `_reports` (disposable telemetry, re-filed on recurrence),
// this is user-facing history, so the TTL is generous. 30 days matches Notion's
// free-tier page-history semantics — the product this feature is modelled on.
//
// PINNED ROWS ARE NOT SPARED — the sweep is unscoped, no `where`. `recordVersion`
// with `{ pin: true }` has exactly one caller: `handle-restore-version.ts`, which
// pins the machine-created "Before restore" undo point so the post-restore
// auto-snapshot can't coalesce over it. A 90-day-old "Before restore" point is no
// more precious than a 90-day-old auto-snapshot. Sparing pinned rows (the
// `where: eq(pinned, false)` analogue of reports' `taskId IS NULL` scope) would
// leave one immortal row per restore click — the table would stay unbounded,
// defeating the policy. If a manual "named version" feature ever lands, the
// protective scope should key off a NEW `user_created` flag, not off `pinned`,
// which is an internal coalescing barrier.
//
// Accepted semantic: a page untouched for >30 days loses its entire timeline (the
// dialog goes empty, restore becomes impossible). Intended. Nothing is lost that
// the live entity doesn't still hold — versions are only useful as *past* states.
//
// `perWorktree: true`: `entity_versions` lives in the per-worktree DB fork, so
// each backend sweeps its own rows; main-only would leave every fork unbounded.
//
// This `defineRetention` call IS `entity_versions`'s growth bound — there is no
// separate "firehose" declaration to make. The bound is recorded in the
// growth-bound registry only when `entityVersionsRetention` is mounted in
// `register: [...]` (see `../index.ts`), so a defined-but-unmounted policy records
// nothing rather than lying about coverage.
export const entityVersionsRetention = defineRetention({
  table: _entityVersions,
  column: "createdAt",
  ttlDays: 30,
  perWorktree: true,
});
