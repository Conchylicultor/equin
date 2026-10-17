import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { sql } from "drizzle-orm";
import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
// Straight to the file, not through `../../core`: drizzle-kit's schema loader
// evaluates this module on its own to read the DDL, and the core barrel also
// carries the endpoint and resource descriptors it has no business pulling in.
import { releaseRunsEntityRef } from "../../core/resources";

// The `release_runs` table, built from its ref (core/resources.ts).
//
// - `namespace` (worktree slug, or MAIN_WORKTREE_NAME on main) produced this
//   run. A worktree DB forks main and inherits main's rows; tagging the
//   producing namespace lets the history resource and orphan sweep scope to
//   their own runs so inherited rows don't surface as phantom state.
// - `kind` is NOT NULL with a `staged` default so every row that existed before
//   candidates reads as what it actually was, and no consumer has to handle a
//   null third state.
// - `pid` is the OS pid of the detached `./singularity release` process that
//   owns this run. It outlives backend restarts, so its liveness — not an
//   in-process flag — is the source of truth for whether the release is still
//   running. Used by the durable lock and the orphan reconciler. A server
//   field: never on the wire.
const releaseRunsEntity = defineEntity(
  releaseRunsEntityRef,
  { pid: nullable(intField()) },
  {
    primaryKey: "id",
    columns: {
      namespace: { default: MAIN_WORKTREE_NAME },
      kind: { default: "staged" },
      status: { default: "running" },
      startedAt: { default: defaultNow() },
    },
    indexes: (t) => [
      // At most one in-flight release per (namespace, composition), enforced
      // atomically by the DB. Unlike build (one in-flight per namespace),
      // concurrent releases of DIFFERENT compositions are legitimate — only a
      // duplicate in-flight release of the SAME composition is blocked. The
      // claiming INSERT itself is the lock: the loser fails with 23505 and bails.
      uniqueIndex("release_runs_inflight_uniq")
        .on(t.namespace, t.composition)
        .where(sql`${t.finishedAt} IS NULL`),
      // Supports the composition-scoped history window (the `release.history`
      // collection, scoped per composition by the history pane): it reads a
      // single composition's runs newest-first, so this covers the
      // `WHERE namespace = ? AND composition = ? ORDER BY started_at DESC`
      // prefix + tiebreak.
      index("release_runs_ns_comp_started_idx").on(
        t.namespace,
        t.composition,
        t.startedAt.desc(),
      ),
      // Supports the unified runs view's release arm, on every page of every
      // scroll. The arm carries an always-on `where namespace = ?`
      // (runs-arm/server), so its subselect is unconditionally
      // `WHERE namespace = ? ORDER BY started_at DESC, id ASC LIMIT n`.
      //
      // The `(namespace, composition, started_at desc)` index above CANNOT serve
      // it, and that is not obvious: `composition` sits between the constrained
      // leading column and the ordering column, so the walk breaks in the middle.
      // The two indexes answer different questions — that one covers the
      // `release.history` window's composition-scoped reads, this one the
      // unscoped-by-composition merged list. Neither subsumes the other; do not consolidate.
      //
      // `id` is the keyset tiebreak and part of the ordering, not padding — see
      // the twin index on build_runs for the full argument, including why there is
      // no unscoped `(started_at desc, id)` here either and what would bring it
      // back (making the arm's hard namespace scope widenable).
      index("release_runs_ns_started_id_idx").on(
        t.namespace,
        t.startedAt.desc(),
        t.id,
      ),
    ],
  },
);

export const _releaseRuns = releaseRunsEntity.table;
