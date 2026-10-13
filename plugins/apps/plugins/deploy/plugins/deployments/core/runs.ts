import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";

/**
 * The verbs over a deployment, as the app launches them.
 *
 * **The CLI is the engine; this is only a launcher.** `./singularity deploy
 * converge|ship` owns every refusal, every host mutation and the health gate —
 * the endpoint spawns exactly that command and streams its output. Nothing about
 * converge or ship is re-implemented server-side, which is the same split
 * `release` (CLI) / Studio (UI) already uses.
 *
 * `update` is the exception that proves it: it is **not** a CLI subcommand but a
 * sequence of the two real ones with an engine release between them —
 * `converge → [build a candidate, unless one is already current] → ship
 * --release <runId>`. It re-implements no refusal, no host mutation and no
 * health gate; it only orders things the caller would otherwise have to order by
 * hand. It is the app's one primary action; `converge` and `ship` stay because
 * the row actions and scripted callers still name them individually.
 */
export const DeployVerbSchema = z.enum(["converge", "ship", "update"]);
export type DeployVerb = z.infer<typeof DeployVerbSchema>;

/**
 * Which leg of an `update` is running.
 *
 * Reported as a field rather than parsed out of the log, because the log is the
 * CLI's prose and a UI that scraped it would break the first time a message
 * changed. Null for `converge` and `ship`, whose verb already names their only
 * phase — so "a single-verb run has no phase" is a fact of the type, not a
 * convention.
 */
export const DeployPhaseSchema = z.enum(["converge", "build", "ship"]);
export type DeployPhase = z.infer<typeof DeployPhaseSchema>;

/**
 * The durable log channel every CLI spawn streams into — the shape release uses
 * (`RELEASE_LOG_CHANNEL`), so the UI's log panel is the same panel.
 *
 * It is ONE channel rather than one per deployment: a run is exclusive per
 * server (the endpoint refuses a concurrent one), the CLI prefixes each run with
 * its own argv line, and a channel is a declared, rotation-bounded file sink —
 * minting one per deployment row would make that bound a function of runtime
 * data.
 */
export const DEPLOY_LOG_CHANNEL = "deploy";

/**
 * The state of the most recent run — `converge`, `ship` or `update` — for one
 * deployment: the **live view**.
 *
 * In-memory state projected into a live value (the `release.previews` shape),
 * because that is what a live view is: progress at phase granularity, for
 * whatever is happening now. What it is NOT is the record — `deploy_runs` is
 * (see {@link DeployRunRecordSchema}), written by the same functions that write
 * this map. The pair is deliberate and neither replaces the other:
 *
 * - this answers *what is happening right now*, with no query;
 * - the table answers *what happened*, across restarts, for every run.
 *
 * A restart no longer empties it. The CLI is spawned as a **supervised run** —
 * detached, with its output going to a transcript file rather than a pipe — so
 * the child outlives the backend, and the boot reconciler rebuilds this map's
 * entry from the ledger row while re-publishing the transcript into the log
 * channel. The run reappears as running, with output still scrolling, which is
 * the whole point: a `./singularity build` restarting the backend used to kill
 * the deploy outright (`drun-1787890652933-wr3v6d`).
 *
 * Rebuilt at boot and never persisted, so it cannot go stale — the `op-status` /
 * `prototypes/thumbnails` idiom.
 */
export const DeployRunSchema = z.object({
  /**
   * This run's identity — the same string as its `deploy_runs.id`, so the live
   * view and the ledger row name ONE run rather than two records that have to be
   * matched up by timestamp.
   */
  id: z.string(),
  /** `deploy_deployments.id` — one entry per deployment, the map's key. */
  deploymentId: z.string(),
  /** Copied off the row so a consumer can reason about server exclusivity. */
  serverId: z.string(),
  compositionId: z.string(),
  verb: DeployVerbSchema,
  /**
   * Which leg of an `update` is running (or was running when it ended), and null
   * for the two single-verb runs — see {@link DeployPhaseSchema}. The one thing
   * a progress report needs that the verb alone cannot say.
   */
  phase: DeployPhaseSchema.nullable(),
  /**
   * The release run id this `ship` pinned (`--release <runId>`), or null.
   *
   * Null covers "this was a converge", "this ship named no run and took whatever
   * `latest-<platform>` pointed at", and "this update has not reached its ship
   * leg yet" — the cases where there is no pinned id to record, which is exactly
   * what the CLI was told. An `update` fills it at the instant it resolves the
   * bundle, so the record can never claim to be shipping without naming what.
   * Recorded so
   * *what is live on this box* is answerable from the run record instead of by
   * reading back the argv line out of the log channel.
   *
   * Deliberately NOT validated semantically here: whether that run exists, is
   * packed, matches the composition and matches the host's platform is
   * `resolveBundle`'s verdict, and re-checking it here would be a second
   * implementation of discovery. The CLI owns every refusal.
   */
  release: z.string().nullable(),
  /**
   * The commit the bundle this run is shipping was built from
   * (`RELEASE.json.commitSha`), or null.
   *
   * Set in the same write as `release`, from the resolved bundle's manifest —
   * the only place the answer is actually known. It stays null wherever it
   * genuinely is not: a converge ships nothing, and a bare `ship` lets the CLI
   * pick `latest-<platform>` inside its own process, so this app never saw which
   * bundle went out. HEAD is deliberately NOT substituted: the sha of the tree
   * this backend was built from is not the sha of the bytes on the box, and a
   * plausible wrong answer is worse than an absent one.
   */
  commitSha: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string(),
  /** Null while `running`. */
  finishedAt: z.string().nullable(),
  /** Null while running, and when the command could not be spawned at all. */
  exitCode: z.number().int().nullable(),
  /**
   * On failure: the CLI's own words. A refusal is never summarised or
   * reinterpreted here — the whole point is that "the command refused, and this
   * is what it said" reaches the user instead of a generic failure.
   */
  message: z.string().nullable(),
});
export type DeployRun = z.infer<typeof DeployRunSchema>;

/**
 * Every deployment's most recent run, keyed by deployment id — ONE value, read
 * whole with `useLive(deployRuns)`.
 *
 * Whole rather than per deployment because a reader needs every run on a
 * server at once (`useBlockedReason` asks "is anything running on this box?").
 * Served from process memory (`serveValue`'s external arm, in
 * `server/internal/run-state.ts`), so no row-count bound applies: the map holds
 * at most one entry per deployment row, written only for a row that exists.
 *
 * No placeholder: before the first value lands the read is `pending`, which is
 * NOT "nothing has run" — the Deploy buttons stay blocked until it settles.
 */
export const deployRuns = liveValue("deploy.runs", {
  schema: z.record(z.string(), DeployRunSchema),
});

/**
 * One `deploy_runs` row: the **record** of a run, as the history query returns it.
 *
 * The live view above and this are the same run seen from two distances, which
 * is why they share an `id` and not a schema. The differences are all
 * deliberate:
 *
 * - `phaseFailed` instead of `phase` — a *finished* run's live phase is only
 *   interesting when it is the leg that killed it, and stamping it under that
 *   name means nothing has to remember the convention to read the row;
 * - dates, not ISO strings — this shape is fed to a DataView, where a `date`
 *   field sorts and filters on a real `Date`.
 */
export const DeployRunRecordSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  /**
   * Copied off the deployment rather than joined, so the row states which box it
   * happened to without needing the deployment to still exist... which, in fact,
   * it must (the FK cascades). It is here because a run record that cannot say
   * *where* is not a record of a deploy.
   */
  serverId: z.string(),
  compositionId: z.string(),
  verb: DeployVerbSchema,
  /** The pinned release run id (`ship --release`), or null — as on the live run. */
  releaseRunId: z.string().nullable(),
  /** The commit that bundle was built from, or null — as on the live run. */
  commitSha: z.string().nullable(),
  /**
   * `running` now means running. A backend that died mid-run used to leave the
   * row here forever, because the process that would have stamped the outcome
   * was the process that went away; the supervised-run reconciler closes those
   * on the next boot from the child's **own** exit marker — a status the child
   * recorded, not one a sweep invented — and re-attaches the ones still going.
   *
   * Two rows can still read `running` without being: one written before
   * supervision existed (no leg to speak for it), and one launched by a
   * different namespace and inherited through the DB fork. Neither is this
   * process's to close, and both stay as the honest record of what was observed.
   */
  status: z.enum(["running", "succeeded", "failed"]),
  /** Which leg an `update` died on. Null unless the run failed on one. */
  phaseFailed: DeployPhaseSchema.nullable(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  exitCode: z.number().int().nullable(),
  /** On failure: the CLI's own words, stored and rendered verbatim. */
  message: z.string().nullable(),
});
export type DeployRunRecord = z.infer<typeof DeployRunRecordSchema>;

/**
 * The deploy history DataView's id (its `storageKey`): the surface
 * `deployRunHistory` is listed on, whose custom columns sort and filter it.
 * The DataView declares the same literal with `defineDataView` (a web-only
 * marker the codegen scrapes) and asserts at mount that the two agree.
 */
const DEPLOY_HISTORY_VIEW_ID = "deploy.deployment.history";

/**
 * The `deploy_runs` ledger as a live window — the deployment pane's History
 * DataView source (research/2026-09-29-global-scoped-change-routing.md P3), the
 * pane scoping it to one deployment (`scoped({ where: { deploymentId } })`).
 * A run opening, finishing or failing reaches the tuples holding it through
 * the routed runtime: no revision tick, no refetch. Read as key-range pages
 * (no depth limit — a ledger only grows), and its `columnScope` is the
 * history surface, so that surface's custom columns sort and filter it.
 */
export const deployRunHistory = liveCollection("deploy.run-history", {
  row: DeployRunRecordSchema,
  id: "id",
  filterable: {
    deploymentId: liveText(),
    verb: liveText(DeployVerbSchema),
    status: liveText(),
    releaseRunId: liveText(),
    commitSha: liveText(),
    message: liveText(),
    startedAt: liveInstant(),
    finishedAt: liveInstant(),
  },
  sortable: [
    "status",
    "verb",
    "commitSha",
    "releaseRunId",
    "startedAt",
    "finishedAt",
  ],
  default: { orderBy: [["startedAt", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: DEPLOY_HISTORY_VIEW_ID,
});
