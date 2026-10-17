import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { _deployServers } from "@plugins/apps/plugins/deploy/plugins/servers/server";
// The specific module, not the `core` barrel: drizzle-kit loads this file to
// build the schema, and `core/derive.ts` is plain strings with no imports at all.
import { DEFAULT_LOOPBACK_PORT } from "../../core/derive";
import { idColumn } from "@plugins/ids/server";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { deploymentIdKind, deployRunIdKind } from "../../core/id-kinds";
// The specific module too: `core/verbs.ts` is zod alone.
import { DeployPhaseSchema, DeployVerbSchema } from "../../core/verbs";

// Where a composition is served and under what URL: `(composition × server) →
// { hostnames, loopbackPort }`. Runtime data, deliberately not repo state — the
// same composition can be served on many surfaces, and a URL is a deploy/server
// concern rather than a property of the software. See `../../core/schemas.ts`
// for what is absent and why (the run user, dir layout, unit and platform are
// all derived, never columns).
export const _deployDeployments = deriveUpdatedAt(
  pgTable(
    "deploy_deployments",
    {
      id: idColumn(deploymentIdKind),
      // A composition NAME from the `compositions` config. No FK to point at —
      // compositions are config_v2 data, not rows — so the create handler
      // validates membership at write time.
      compositionId: text("composition_id").notNull(),
      serverId: text("server_id")
        .notNull()
        .references(() => _deployServers.id, { onDelete: "cascade" }),
      // Public hostnames Caddy serves this deployment on. Empty is legal: an
      // install can exist before DNS does. `exposure` is derived from this array
      // being non-empty, never declared — a deployment behind an open 443 with a
      // public hostname simply IS public, so there is no flag to typo.
      hostnames: text("hostnames").array().notNull(),
      loopbackPort: integer("loopback_port")
        .notNull()
        .default(DEFAULT_LOOPBACK_PORT),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (t) => [
      // The two invariants are carried by the DB, so neither needs a check and
      // neither can be lost to a concurrent write.
      //
      // One install of a composition per server. This is what buys the
      // single-name property: with no second deployment to disambiguate, the
      // composition name alone can name the install dir, the systemd instance,
      // the runtime namespace and the database. Staging and prod of one
      // composition therefore live on different servers, which is the normal
      // arrangement anyway; a `slot` discriminator is the documented way to lift
      // this if a real need appears.
      uniqueIndex("deploy_deployments_composition_server_uq").on(
        t.compositionId,
        t.serverId,
      ),
      // The port is the only resource two installs on one box contend for.
      uniqueIndex("deploy_deployments_server_port_uq").on(
        t.serverId,
        t.loopbackPort,
      ),
    ],
  ),
  {
    touchedBy: {
      compositionId: true,
      serverId: true,
      hostnames: true,
      loopbackPort: true,
      id: false,
      createdAt: false,
    },
  },
);

// The deploy ledger: one row per launched run — *what was put on this box, when,
// from which commit, and what happened*. It exists because `deploy.runs` is an
// in-memory Map that a backend restart empties, which left that question
// unanswerable after a reboot; the two are not redundant (see `../../core/runs.ts`:
// the Map is the live view, this is the record).
//
// It is also the **durable lock and the re-attach index**. The claiming INSERT is
// what wins or loses the race for a server (see the partial unique index below),
// and `launched_from` / `leg_run_id` / `pid` are what let a backend that restarted
// mid-run find the CLI child it left behind and adopt it — the supervised-run
// contract, whose kind for this table is defined in `run-state.ts`.
//
// Written only by `run-state.ts` — `claimRun` opens a row, and `failRun` or the
// supervised-run kind's `closeRow` stamps its outcome — so there is exactly one
// writer and the live view and the record can never disagree about a run they
// both name by the same `id`.
export const _deployRuns = pgTable(
  "deploy_runs",
  {
    id: idColumn(deployRunIdKind),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => _deployDeployments.id, { onDelete: "cascade" }),
    // Copied off the deployment at launch, not joined. Both are create-only on
    // the deployment, so this cannot drift — it is here so a row states which box
    // and which software without a join, and keeps saying so while the query
    // filters by deployment.
    serverId: text("server_id").notNull(),
    compositionId: text("composition_id").notNull(),
    // Decoded by its closed set on every read and write, so the runs list's
    // `deploy.verb` binds to it by name as the enum it is.
    verb: parsedText("verb", DeployVerbSchema).notNull(),
    // The pinned release run id (`ship --release <id>`). Null where there is
    // genuinely none: a converge, or a bare ship that let the CLI follow
    // `latest-<platform>` inside its own process.
    releaseRunId: text("release_run_id"),
    // The commit the shipped bundle was built from, read off the resolved
    // bundle's manifest. Null where unknown — never HEAD, which is a fact about
    // this checkout rather than about the bytes that went out.
    commitSha: text("commit_sha"),
    status: text("status").notNull().default("running"), // running|succeeded|failed
    // The worktree whose backend LAUNCHED this run — not where the software
    // went. A worktree DB is a fork of main's and inherits main's rows, so
    // without this a worktree backend would reconcile (and close, and re-attach
    // to) another namespace's runs, surfacing phantom failures everywhere.
    //
    // Deliberately not called `namespace`, which is what `build_runs` and
    // `release_runs` call the same column: those runs HAPPEN in a worktree, and
    // the runs-arm reads `namespace: null` for a deploy precisely because a
    // deploy targets a remote host. Both facts are true at once only if the
    // column says which one it is.
    //
    // The `main` default is for rows written before this column existed. They
    // are all finished (or legacy-stuck, see `leg_run_id`), so attributing them
    // to main costs nothing and keeps the column NOT NULL — the same call
    // `release_runs.namespace` makes.
    launchedFrom: text("launched_from").notNull().default(MAIN_WORKTREE_NAME),
    // The supervised-run id of the CLI leg this row is currently waiting on —
    // `<id>.converge` or `<id>.ship` (`server/internal/legs.ts` owns the
    // grammar). It is the name of the run's transcript and exit-marker files, so
    // storing it makes the row→artifact mapping a recorded fact rather than a
    // re-derivation two files could disagree about.
    //
    // An `update` rewrites it when it moves from its converge leg to its ship
    // leg, and always BEFORE that leg is spawned — a restart in the gap must
    // find the child that is actually running, not the one that just ended.
    //
    // Null only on rows written before supervision existed. Those are skipped by
    // `listUnfinished`: there are no artifacts to read and no pid to trust, so
    // nothing this process can honestly say about them.
    legRunId: text("leg_run_id"),
    // The OS pid of the process this run belongs to: seeded with the claiming
    // backend's own `process.pid`, then replaced with the detached CLI leg's pid
    // once it is spawned. The seed is what keeps a freshly-claimed row from
    // looking like an orphan in the window before the child exists.
    //
    // Internal only — never on the wire: the history collection projects
    // exactly `DeployRunRecordSchema`'s keys, exactly as `release_runs.pid` is.
    pid: integer("pid"),
    // The leg an `update` died on. Null unless the run failed on one — a
    // succeeded run has no failing phase, and a single-verb run has no phases.
    phaseFailed: parsedText("phase_failed", DeployPhaseSchema),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Null while running — and *only* while running. A backend that dies mid-run
    // used to leave this null forever, because the process that would have
    // stamped it was the process that went away; the supervised-run reconciler
    // now closes those on the next boot from the child's own exit marker, so a
    // null here means the leg is genuinely still in flight. The exception is a
    // row with no `leg_run_id` (written before supervision), which nothing can
    // speak for and nothing will close.
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    // The CLI's own words on a failure, stored verbatim.
    message: text("message"),
  },
  (t) => [
    // **At most one in-flight run per (launcher, server) — and this index IS the
    // exclusivity lock.** Converge writes `/etc/caddy/Caddyfile` and runs
    // `apt-get`, so two of them on one box race even for different
    // compositions; an `update` holds the server for its whole sequence for the
    // same reason. The claiming INSERT wins or loses here, which closes the
    // check-then-act window the previous in-memory `Map` check had and, unlike
    // that Map, survives a restart.
    //
    // `launched_from` leads, and it is load-bearing rather than decorative. The
    // scope this can honestly enforce is per-DB, and each namespace has its own
    // DB fork — so cross-namespace exclusivity was never enforced and cannot be
    // (that is the same strength the in-memory check had). What leading with it
    // BUYS is that a still-`running` row inherited from main at fork time
    // cannot wedge a worktree's deploys to that server forever. Legacy rows
    // carry the `main` default, so they only ever contend with main's own.
    uniqueIndex("deploy_runs_server_inflight_uq")
      .on(t.launchedFrom, t.serverId)
      .where(sql`${t.finishedAt} IS NULL`),
    // That index also serves the reconciler's read — every unfinished row this
    // namespace launched, on boot and on every artifact event — because its
    // leading column and its predicate are exactly that query. No second index.
    // Covers the per-deployment history window's `WHERE deployment_id = ?
    // ORDER BY started_at DESC` read and its scroll cuts + tiebreak.
    index("deploy_runs_deployment_started_idx").on(
      t.deploymentId,
      t.startedAt.desc(),
    ),
    // Covers the UNSCOPED read — the unified runs query's per-arm subselect,
    // `ORDER BY started_at DESC, id ASC LIMIT n`, and the nightly retention
    // sweep's range scan on the same column. The index above cannot serve
    // either: both bind no deployment, so its leading column is dead and the
    // ordering degrades to a top-N heapsort over the whole ledger. Both indexes
    // are needed; neither subsumes the other. (No namespace to lead with —
    // a deploy targets a remote server, so this arm carries no worktree
    // predicate, unlike the build and release arms. See the arm's CLAUDE.md.)
    index("deploy_runs_started_id_idx").on(t.startedAt.desc(), t.id),
  ],
);
