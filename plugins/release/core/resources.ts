import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldOptionMeta,
} from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { idKindField } from "@plugins/ids/core";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";
import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { ReleaseLogsResponseSchema } from "./endpoints";
import { RELEASE_TARGETS } from "./targets";

// WHY a run was cut. `candidate` is packed and built for a named platform — a
// bundle `ship` can pick; `staged` is a `--dev` run that claims no
// `latest-<platform>` pointer and is previewable only. A closed set private to
// the release engine, so it is also the `release_runs.kind` column's decoder
// (see server/internal/tables.ts) — an outsider is a bug, not a value to widen
// for.
export const ReleaseRunKindSchema = z.enum(["staged", "candidate"]);

/**
 * The two ways a release run is cut, and how each reads.
 *
 * A `Record` over the kinds rather than a hand-written value list, so a third
 * kind is a `tsc` error here rather than a value that filters to nothing
 * because the dropdown never offered it.
 */
const RELEASE_KIND_OPTIONS = {
  staged: {
    label: "Staged",
    hint: "A --dev run: previewable, claiming no latest-<platform> pointer.",
  },
  candidate: {
    label: "Candidate",
    hint: "Packed and built for a named platform — a bundle `ship` can pick.",
  },
} as const satisfies Record<
  z.infer<typeof ReleaseRunKindSchema>,
  FieldOptionMeta
>;

// Where a run stands. Same closed-set policy as `ReleaseRunKindSchema`, and it
// likewise decodes the `release_runs.status` column.
export const RELEASE_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export const ReleaseRunStatusSchema = z.enum(RELEASE_RUN_STATUSES);

// One release run as seen by the client — the `release_runs` table is built
// from these fields, plus `pid`, its server field (an internal liveness marker,
// see tables.ts), never part of the public resource payload.
//
// The fields a release-history list shows, in its order (`target` the title);
// `composition` scopes the history to one composition (its pane states it as
// data) and is not the list's to show.
const RELEASE_RUN_LISTED = {
  // A free string (a run cut for a target since removed still reads), so its
  // chips come from the declared targets, not from a closed set.
  target: textField({
    label: "Target",
    primary: true,
    optionMeta: Object.fromEntries(
      RELEASE_TARGETS.map((t) => [t.id, { label: t.label }]),
    ),
  }),
  status: enumTextField(RELEASE_RUN_STATUSES, {
    label: "Status",
    default: "running",
    options: {
      running: { label: "Running", variant: "warning" },
      succeeded: { label: "Succeeded", variant: "success" },
      failed: { label: "Failed", variant: "destructive" },
    },
  }),
  platform: nullable(textField({ label: "Platform" })),
  startedAt: dateField({ label: "Started" }),
  finishedAt: nullable(dateField({ label: "Finished" })),
  composition: textField({ label: "Composition" }),
};
const RELEASE_RUN_CARRIED = {
  id: idKindField(releaseRunIdKind),
  namespace: textField(),
  // Stamped from the request's `ReleaseIntent` at claim time. Never null:
  // pre-existing rows read `staged` through the column default, which is what
  // they were.
  // "Release kind", not "Kind": in a list of every kind of run (`runs`), the
  // run's own kind is another field entirely.
  kind: enumTextField(ReleaseRunKindSchema.options, {
    label: "Release kind",
    default: "staged",
    options: RELEASE_KIND_OPTIONS,
  }),
  exitCode: nullable(intField()),
  artifactPath: nullable(textField({ label: "Artifact" })),
  port: nullable(intField()),
  // Provenance of the source tree this run was cut from. Null on runs that never
  // wrote a manifest, and on rows predating provenance. `commitDirty` forces
  // `Staleness.unknown` — the sha names the parent commit, not the bytes.
  commitSha: nullable(textField({ label: "Commit" })),
  commitDirty: nullable(boolField({ label: "Dirty tree" })),
  error: nullable(textField()),
};
/**
 * A release run's fields — the one record of them: the history list's listed
 * and carried fields, the by-id lookup's row, and the `release_runs` entity
 * the runs union's release arm picks from.
 */
export const releaseRunFields = {
  ...RELEASE_RUN_CARRIED,
  ...RELEASE_RUN_LISTED,
};

/**
 * The `release_runs` entity, by reference — what a browser-safe declaration
 * names a release run WITH (the runs union's release arm `from`, an extension
 * shape's `exposes.parent`). The table is built from it
 * (`server/internal/tables.ts`).
 */
export const releaseRunsEntityRef = entityRef("release_runs", releaseRunFields);

export const ReleaseRunSchema = fieldsToZodObject(releaseRunFields);

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
  from: releaseRunsEntityRef,
  carry: {
    pick: [
      "id",
      "namespace",
      "kind",
      "exitCode",
      "artifactPath",
      "port",
      "commitSha",
      "commitDirty",
      "error",
      "target",
      "status",
      "platform",
      "startedAt",
      "finishedAt",
      "composition",
    ],
  },
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
// P3). Read as key-range pages (no depth limit), scoped by the pane to
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
  from: releaseRunsEntityRef,
  pick: [
    "target",
    "status",
    "platform",
    "startedAt",
    "finishedAt",
    "composition",
  ],
  carry: {
    pick: [
      "id",
      "namespace",
      "kind",
      "exitCode",
      "artifactPath",
      "port",
      "commitSha",
      "commitDirty",
      "error",
    ],
  },
  id: "id",
  sortable: ["target", "status", "platform", "startedAt", "finishedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: RELEASE_HISTORY_VIEW_ID,
});

/** A history row as `releaseHistory` delivers it: the run's fields and its exposed `$columns`. */
export type ReleaseHistoryRow =
  typeof releaseHistory extends LiveRowsCollection<infer R> ? R : never;

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
