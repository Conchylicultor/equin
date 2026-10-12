import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { ReleaseLogsResponseSchema } from "./endpoints";
import {
  liveInstant,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";

// WHY a run was cut. `candidate` is packed and built for a named platform — a
// bundle `ship` can pick; `staged` is a `--dev` run that claims no
// `latest-<platform>` pointer and is previewable only. A closed set private to
// the release engine, so it is also the `release_runs.kind` column's decoder
// (see server/internal/tables.ts) — an outsider is a bug, not a value to widen
// for.
export const ReleaseRunKindSchema = z.enum(["staged", "candidate"]);

// Where a run stands. Same closed-set policy as `ReleaseRunKindSchema`, and it
// likewise decodes the `release_runs.status` column.
export const ReleaseRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
]);

// One release run as seen by the client. Mirrors the `release_runs` table EXCEPT
// `pid` — that is an internal liveness marker (see tables.ts), never part of the
// public resource payload.
export const ReleaseRunSchema = z.object({
  id: z.string(),
  composition: z.string(),
  target: z.string(),
  namespace: z.string(),
  // Stamped from the request's `ReleaseIntent` at claim time. Never null:
  // pre-existing rows read `staged` through the column default, which is what
  // they were.
  kind: ReleaseRunKindSchema,
  status: ReleaseRunStatusSchema,
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  exitCode: z.number().int().nullable(),
  platform: z.string().nullable(),
  artifactPath: z.string().nullable(),
  port: z.number().int().nullable(),
  // Provenance of the source tree this run was cut from. Null on runs that never
  // wrote a manifest, and on rows predating provenance. `commitDirty` forces
  // `Staleness.unknown` — the sha names the parent commit, not the bytes.
  commitSha: z.string().nullable(),
  commitDirty: z.boolean().nullable(),
  error: z.string().nullable(),
});

export type ReleaseRun = z.infer<typeof ReleaseRunSchema>;

// The `release_runs` rows, read by id: a lookup-only collection (no default
// window yet), so it mints `release.runs:rows` alone. The run-detail pane's
// sections each read their run with `useLiveRow(releaseRuns, runId)` — any run,
// regardless of age — and `found: false` is "no such run". The `:rows` point
// routing sends a status flip to that run's readers alone.
//
// The history window is `releaseHistory` below: namespace-scoped, which a
// by-id read must not be.
//
// NOT preloaded (a lookup-only collection cannot be; the run-detail pane lives
// deep in Studio, not first paint). The server projects exactly this schema's
// keys, so `pid` — absent here — never reaches the wire.
export const releaseRuns = liveCollection("release.runs", {
  row: ReleaseRunSchema,
  id: "id",
});

/**
 * The Studio release-history DataView's id (its `storageKey`): the surface
 * `releaseHistory` is listed on, whose custom columns sort and filter it. The
 * DataView declares the same literal with `defineDataView` (a web-only marker
 * the codegen scrapes); the DataView asserts at mount that the two agree.
 */
const RELEASE_HISTORY_VIEW_ID = "studio.release.history";

// This namespace's release runs, newest first — the Studio release-history
// DataView's live source (research/2026-09-29-global-scoped-change-routing.md
// P3). A scroll collection (read as key-range pages, no depth limit), scoped by the pane to
// one composition (`scoped({ where: { composition } })`) and by the server to
// this namespace's runs (a worktree's fork inherits main's rows); a status flip
// or a new run reaches the tuples holding it, through the routed runtime —
// no revision tick, no refetch. Its `columnScope` is the history surface, so
// the surface's custom columns sort and filter it server-side.
//
// Its own collection beside `releaseRuns`: the lookup resolves a run by id
// whichever namespace produced it, while this window is namespace-scoped (a
// collection's base `where` applies to its `:rows` read too).
export const releaseHistory = liveCollection("release.history", {
  row: ReleaseRunSchema,
  id: "id",
  filterable: {
    composition: liveText(),
    target: liveText(),
    status: liveText(ReleaseRunStatusSchema),
    platform: liveText(),
    startedAt: liveInstant(),
    finishedAt: liveInstant(),
  },
  sortable: ["target", "status", "platform", "startedAt", "finishedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: 100 },
  maxLimit: 500,
  scroll: true,
  columnScope: RELEASE_HISTORY_VIEW_ID,
});

// One running (or stopping) preview of a release run's artifact.
export const PreviewSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "stopped"]),
  port: z.number().int(),
  url: z.string(),
});

export type Preview = z.infer<typeof PreviewSchema>;

// In-memory preview state, keyed by runId. Truth lives in the server's preview
// manager (an in-memory Map), not Postgres, so the server serves it from the
// external arm (`releasePreviewsServed.notify()` on every start / stop / reap).
// Bounded by the live preview processes, so no `unbounded` reason. No
// placeholder: before the first value lands the read is `pending`, never an
// empty record claiming "no previews".
//
// `preload: "boot"` is parity with the resource it replaces; its one reader is
// a Studio pane, which is why `web/internal/register.ts` pulls this module into
// the eager web import graph.
export const releasePreviews = liveValue("release.previews", {
  schema: z.record(z.string(), PreviewSchema),
  preload: "boot",
});

/**
 * One release run's persisted log — every line of its supervised-run
 * transcript, by run id. The run-detail pane reads it once the run is no longer
 * live (an in-flight run streams over the `release` log channel instead).
 *
 * Served external, `notified` by a watch on the transcript file for as long as
 * a tuple is read: a live run's transcript grows, the artifact prune can reap a
 * finished one, and a terminal run's never changes again — so the watch is
 * silent exactly when the answer is immutable, without the loader reading the
 * run row to tell the two apart.
 *
 * An id that is not a single path segment (it names the transcript's filename)
 * is refused `invalid-id` — a malformed question, not a server failure.
 */
export const releaseRunLogs = liveValue("release.run-logs", {
  schema: ReleaseLogsResponseSchema,
  params: ["id"],
  refusals: ["invalid-id"],
});
