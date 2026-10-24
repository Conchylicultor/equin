import type { PgTable } from "drizzle-orm/pg-core";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import { tableLabel } from "./table-label";

// A plugin opts ITS OWN table's ROWS out of the worktree DB fork by adding
// `ExcludeFromFork({ table, reason })` to its server `contributions`. The table
// is created in the forked DB with its full DDL but no rows.
//
// WHEN TO USE THIS — and the trade you are making. A worktree DB is forked from
// main so an agent starts with the tasks, conversations and pages it needs to do
// its job. Excluding a table says "a fresh worktree has no use for main's rows
// here, and will never re-populate them." That is the correct trade for two
// kinds of table:
//
//   - **Host-local observability.** Traces, slow-op aggregates, crash reports,
//     model-call logs, notifications. These record what happened on the machine
//     that produced them; an inherited row is at best noise in the fork's own
//     debug pane and at worst a phantom (main's undismissed notifications
//     appearing in a fresh worktree's bell). They are also, by volume, most of
//     the fork — `traces` alone is 949 MB of a 2057 MB source database.
//     (Leaving rows out of the nightly BACKUP is a separate decision with its
//     own token — `ExcludeFromBackup` in ./backup-exclusion. `traces` declares
//     both.)
//   - **Derived state rebuilt on boot.** The live-state snapshot + changelog are
//     a cold-boot accelerator; `boot-init.ts` degrades to a full recompute when
//     they are absent.
//
// It is the WRONG trade for anything a human authored or an agent must read.
// `reason` is required so the decision is a reviewed, documented one rather than
// a silent data-loss footgun — the exclusion is invisible until someone wonders
// why a table in their fork is empty.
//
// EXCLUDE DERIVED STATE TOGETHER WITH ITS SOURCES. A persisted live-state value
// is computed FROM other tables; keeping the snapshot while emptying a table it
// read makes the fork serve a value that disagrees with the rows behind it. That
// is why `live_state_snapshot` and `live_state_changelog` are excluded alongside
// the observability tables rather than kept as an optimisation.
//
// This token lives in `database/admin` rather than beside the fork JOB in
// `database/fork` because `database/fork` imports `shell/notifications` (to
// report a failed fork) and `shell/notifications` is itself a declaring plugin —
// hosting the token there would close a cycle. `admin` reaches only two leaf
// plugins, so no declaring plugin can ever cycle back into it.
//
// Collected by the framework at boot before any `onReadyBlocking` runs (same as
// the `View` and `ExcludeFromChangeFeed` contributions), so the fork job sees
// every exclusion regardless of module import order.
export const ExcludeFromFork = defineServerContribution<{
  table: PgTable | string;
  reason: string;
}>("fork-data-exclusion", { docLabel: (c) => tableLabel(c.table) });

// Schemas a plugin's runtime creates for ITSELF rather than declaring as drizzle
// tables — a job queue's bookkeeping, a sync engine's replication state.
// Inheriting their CONTENTS is not merely wasteful, it is wrong: the rows
// describe the producing database.
//
// THE DECLARATION STATES WHAT SURVIVES, NOT WHAT GOES. The schema's DDL is
// always kept and its rows are always dropped; `keep` names the few tables whose
// rows come across anyway. There is deliberately no way to spell "remove the
// schema itself":
//
//   - Nothing can be left dangling. Publications and event triggers are
//     database-level objects that `pg_dump` emits regardless, and each one
//     naming a now-missing schema is a `pg_restore` error. A runtime that
//     installs a publication and event triggers outside its schemas, pointing
//     back in, is exactly that case — removing such schemas once broke the
//     restore on seven statements.
//   - Nothing is born incomplete. A schema that is deleted needs an owner to put
//     it back, and "who recreates it" has no spelling in a contribution — it was
//     prose in a `reason` string. `graphile_worker` is what that cost: a
//     freshly-forked database could not accept a transactional job enqueue until
//     a backend had booted against it.
//
// `keep` is what makes dropping the schema unnecessary. Graphile records its
// migration watermark in `graphile_worker.migrations`, INSIDE the schema; empty
// every table and graphile boots believing it is unmigrated and re-issues
// `CREATE TABLE` against tables that already exist. Keeping that one table — and
// only that one — gives a fork a schema graphile already considers installed,
// with no inherited jobs and no inherited crontab watermarks.
//
// `keep: []` is required rather than optional: "nothing in this schema comes
// across" is the decision being asked for, and an omitted field is not a
// decision.
//
// `schema` is a glob (`ext*` matches a whole `ext`, `ext_0`, `ext_0/log`
// family). It is matched by US against the source catalog, never by
// `pg_dump` — see ./fork-plan, which also refuses a schema no declaration
// matches at all.
export const ExcludeSchemaDataFromFork = defineServerContribution<{
  schema: string;
  keep: readonly string[];
  reason: string;
}>("fork-schema-data-exclusion", { docLabel: (c) => c.schema });

// `ExcludeFromFork` can take a table OBJECT (see ./table-label) because the
// table is ours, and `ExcludeSchemaDataFromFork` cannot, because a foreign
// runtime's schema has none. That tsc-checked spelling is why the two
// contributions above stay two, now that both only ever empty tables: merging
// them would mean giving up the checked form for the twelve declarations that
// have it.

/** One schema-level declaration, as pure data. */
export interface ForkSchemaExclusion {
  /** Glob matched against the SOURCE database's schema names. */
  readonly schema: string;
  /** Exact table names whose rows survive the fork. */
  readonly keep: readonly string[];
}

/**
 * What `forkDatabase` must be told not to copy — the DECLARED set, verbatim.
 *
 * Pure data on purpose. It crosses HTTP for the `./equin db fork` path
 * (`database/fork`'s `GET /api/db/fork-exclusions` → the `cli/db` plugin's
 * `cli/fork.ts`),
 * so nothing here may be a function. Turning it into `pg_dump` flags is a
 * separate step that needs the source database — see ./fork-plan.
 */
export interface ForkExclusions {
  /** Table names in the app schema (`public`) whose rows are dropped. */
  readonly tables: readonly string[];
  /** Foreign schemas whose rows are dropped, minus each one's `keep` list. */
  readonly schemas: readonly ForkSchemaExclusion[];
}

// The declared exclusion set.
//
// THROWS on an empty set. A process that never booted (a CLI, a script) already
// throws inside `getContributions()`; this guards the remaining case, a booted
// graph that declares no exclusion at all. Silently returning "exclude nothing"
// would produce a full ~2 GB fork that looks like it worked. The declarations in
// this repo guarantee a non-empty set in any booted backend.
export function forkExclusions(): ForkExclusions {
  const tables = ExcludeFromFork.getContributions();
  const schemas = ExcludeSchemaDataFromFork.getContributions();
  if (tables.length === 0 && schemas.length === 0) {
    throw new Error(
      "forkExclusions(): no fork exclusions are registered by any loaded plugin.",
    );
  }
  return {
    tables: tables.map((c) => tableLabel(c.table)),
    schemas: schemas.map((c) => ({ schema: c.schema, keep: c.keep })),
  };
}
