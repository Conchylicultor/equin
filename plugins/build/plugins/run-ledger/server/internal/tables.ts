import { sql } from "drizzle-orm";
import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import {
  MAIN_COMPOSITION_ID,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import { buildRunsEntityRef } from "../../core/internal/entity";

// The `build_runs` table, built from its ref (core/internal/entity.ts). The
// CLI never imports it: its recorder writes hand SQL (`shared/recorder.ts`).
//
// Column notes:
//
// - `id` is keyed by the ledger's id kind. Rows minted before it
//   (`<commit>-<ms>`, a hand-run build's old shape) stay readable: the column
//   brands, it does not validate, and lookups go through `buildRunIdKind.key`.
// - `namespace` (worktree slug, or MAIN_WORKTREE_NAME on main) produced this
//   run. A worktree DB is forked from main and inherits main's rows; tagging
//   the producing namespace lets the history resource and orphan sweep scope to
//   their own runs so inherited main builds don't surface a phantom "Build
//   failed". Backfills to MAIN_WORKTREE_NAME — historically only main's
//   auto-build wrote here.
// - `targets` is WHICH COMPOSITIONS this one invocation built. `./singularity
//   build --composition sonata website` is ONE shared build — one install, one
//   codegen, one migration pass, one checks pass, one transcript, one profile,
//   one verdict — so it is ONE row carrying N target chips, not N rows sharing
//   a transcript. A plain build is `{singularity}`. The default is derived from
//   MAIN_COMPOSITION_ID, never spelled.
// - `pid` is the building process — supervisor bookkeeping, a server field
//   (never on the wire).
const buildRunsEntity = defineEntity(
  buildRunsEntityRef,
  { pid: nullable(intField()) },
  {
    primaryKey: "id",
    columns: {
      namespace: { default: MAIN_WORKTREE_NAME },
      targets: { default: [MAIN_COMPOSITION_ID] },
      startedAt: { default: defaultNow() },
    },
    indexes: (t) => [
      // At most one in-flight build per namespace, enforced atomically by the DB.
      // THE lock: the claiming INSERT is what wins or loses, and the loser fails
      // with a 23505 and bails instead of starting a second build.
      //
      // There used to be a pid-liveness pre-check in front of it, and it is gone
      // rather than kept as a fast path — it was a check-then-act with a TOCTOU
      // window. Two triggers racing across backend processes (where the in-process
      // `inflight` flag gives no protection) could both pass the liveness check
      // before either inserted, then both spawn `./singularity build`, and the two
      // competing builds stomp each other's backend restart, leaving both rows
      // unfinished → the reconciler stamps both exit_code=-1. Liveness is now the
      // supervised-run reconciler's single answer, and this index is the only
      // arbiter of the race.
      //
      // Scoped by `namespace` alone. It used to be `(namespace, target)` so main's
      // row and its compose-serve children could be open at once; with no children
      // left it says exactly what the per-checkout `.build.lock` already enforces —
      // one build in flight per checkout.
      //
      // Narrowing it in the same change that drops `target` is safe: an index is
      // DDL, applied by the backend's migration runner and never named by any
      // writer, and both writers (the CLI's hand-written INSERT and run-build.ts)
      // supply `namespace`.
      uniqueIndex("build_runs_inflight_uniq")
        .on(t.namespace)
        .where(sql`${t.finishedAt} IS NULL`),
      // Supports every NAMESPACE-SCOPED ordered read of this table — four of
      // them, not one:
      //
      //   - `buildHistory`'s window (build/server) — the preloaded
      //     `WHERE namespace = ? ORDER BY started_at DESC, id ASC LIMIT 50` the
      //     build BUTTON's own state derives from, on every page load. Without
      //     this it is a scan plus a sort on the boot path.
      //   - `lastMainAttempt` and `lastCompositionAttempt` (wants-build.ts) — the
      //     same scoped shape at LIMIT 1, covered by the same index for free.
      //     Their extra predicates (targets, finished_at) filter after the walk.
      //   - The unified runs view's build arm, on EVERY page of every scroll. The
      //     arm carries an always-on `where namespace = ?` (runs-arm/server), so
      //     its subselect is unconditionally
      //     `WHERE namespace = ? ORDER BY started_at DESC, id ASC LIMIT n`.
      //
      // `id` is NOT padding — do not trim this to `(namespace, started_at desc)`.
      // The fourth reader is a keyset seek, and a keyset seek's tiebreak is part
      // of its ordering — as is a live window's pk tiebreak, for the first:
      // `(namespace, started_at desc)` cannot serve
      // `ORDER BY started_at DESC, id ASC`, and both would fall back to a sort.
      // Only the two LIMIT 1 reads do not tiebreak on `id`, which is exactly why
      // the tail looks trimmable if you only count them.
      //
      // There is deliberately NO unscoped `(started_at desc, id)` twin: the arm's
      // `where` is unconditional, so nothing orders this table without a namespace
      // predicate and such an index would cover no query the planner would pick it
      // for — while still costing a write on every build insert and every finish,
      // on the app's hottest table. IF the scope is ever made widenable (it is
      // filed — an always-on `where` is a constraint, not the editable default the
      // design agreed), an unscoped ordering becomes reachable again and that index
      // earns its place. Adding one later is cheap; carrying a dead one is not.
      index("build_runs_ns_started_id_idx").on(
        t.namespace,
        t.startedAt.desc(),
        t.id,
      ),
    ],
  },
);

export const _buildRuns = buildRunsEntity.table;
