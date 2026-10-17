import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { sql } from "drizzle-orm";
import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { _deployServers } from "@plugins/apps/plugins/deploy/plugins/servers/server";
// The specific modules, not the `core` barrel: drizzle-kit loads this file to
// build the schema, and the barrel carries the endpoint and resource
// descriptors it has no business pulling in.
import { DEFAULT_LOOPBACK_PORT } from "../../core/derive";
import { deployDeploymentsEntityRef } from "../../core/deployment-entity";
import { deployRunsEntityRef } from "../../core/runs";

// Where a composition is served and under what URL: `(composition × server) →
// { hostnames, loopbackPort }`. Runtime data, deliberately not repo state — the
// same composition can be served on many surfaces, and a URL is a deploy/server
// concern rather than a property of the software. See `../../core/schemas.ts`
// for what is absent and why (the run user, dir layout, unit and platform are
// all derived, never columns).
const deployDeploymentsEntity = defineEntity(deployDeploymentsEntityRef, {
  primaryKey: "id",
  columns: {
    serverId: {
      references: { column: () => _deployServers.id, onDelete: "cascade" },
    },
    loopbackPort: { default: DEFAULT_LOOPBACK_PORT },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  updatedAt: {
    touchedBy: {
      compositionId: true,
      serverId: true,
      hostnames: true,
      loopbackPort: true,
      id: false,
      createdAt: false,
    },
  },
  indexes: (t) => [
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
});

export const _deployDeployments = deployDeploymentsEntity.table;

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
//
// Column notes (the record's own are on `deployRunFields`, core/runs.ts):
//
// - `serverId` / `compositionId` are copied off the deployment at launch, not
//   joined. Both are create-only on the deployment, so this cannot drift — it
//   is here so a row states which box and which software without a join, and
//   keeps saying so while the query filters by deployment.
// - `launchedFrom` is the worktree whose backend LAUNCHED this run — not where
//   the software went. A worktree DB is a fork of main's and inherits main's
//   rows, so without this a worktree backend would reconcile (and close, and
//   re-attach to) another namespace's runs, surfacing phantom failures
//   everywhere. Deliberately not called `namespace`, which is what
//   `build_runs` and `release_runs` call the same column: those runs HAPPEN in
//   a worktree, and the runs-arm reads `namespace: null` for a deploy precisely
//   because a deploy targets a remote host. The `main` default is for rows
//   written before this column existed; they are all finished (or
//   legacy-stuck, see `legRunId`), so attributing them to main costs nothing
//   and keeps the column NOT NULL — the same call `release_runs.namespace`
//   makes.
// - `legRunId` is the supervised-run id of the CLI leg this row is currently
//   waiting on — `<id>.converge` or `<id>.ship` (`server/internal/legs.ts`
//   owns the grammar). It is the name of the run's transcript and exit-marker
//   files, so storing it makes the row→artifact mapping a recorded fact rather
//   than a re-derivation two files could disagree about. An `update` rewrites
//   it when it moves from its converge leg to its ship leg, and always BEFORE
//   that leg is spawned — a restart in the gap must find the child that is
//   actually running, not the one that just ended. Null only on rows written
//   before supervision existed; those are skipped by `listUnfinished`.
// - `pid` is the OS pid of the process this run belongs to: seeded with the
//   claiming backend's own `process.pid`, then replaced with the detached CLI
//   leg's pid once it is spawned. The seed is what keeps a freshly-claimed row
//   from looking like an orphan in the window before the child exists.
// - `finishedAt` is null while running — and *only* while running: the
//   supervised-run reconciler closes a dead backend's rows on the next boot
//   from the child's own exit marker. The exception is a row with no
//   `legRunId`, which nothing can speak for and nothing will close.
//
// `launchedFrom`, `legRunId` and `pid` are server fields — supervised-run
// bookkeeping, never on the wire.
const deployRunsEntity = defineEntity(
  deployRunsEntityRef,
  {
    launchedFrom: textField(),
    legRunId: nullable(textField()),
    pid: nullable(intField()),
  },
  {
    primaryKey: "id",
    columns: {
      deploymentId: {
        references: {
          column: () => _deployDeployments.id,
          onDelete: "cascade",
        },
      },
      status: { default: "running" },
      launchedFrom: { default: MAIN_WORKTREE_NAME },
      startedAt: { default: defaultNow() },
    },
    indexes: (t) => [
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
  },
);

export const _deployRuns = deployRunsEntity.table;
