import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { buildRunFields } from "@plugins/build/plugins/run-ledger/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

// One build run as the client sees it: the ledger's fields (run-ledger's
// `buildRunFields`) but `namespace`, which the server scopes the collection by.
// `ledger.pid` is internal and no field at all. All carried: the build
// surfaces read rows by id / newest-first, none filters.
const { id, trigger, commitHash, targets, startedAt, finishedAt, exitCode } =
  buildRunFields;
const BUILD_RUN_FIELDS = {
  id,
  trigger,
  commitHash,
  targets,
  startedAt,
  finishedAt,
  exitCode,
};
export const BuildRunSchema = fieldsToZodObject(BUILD_RUN_FIELDS);

export type BuildRun = z.infer<typeof BuildRunSchema>;

/**
 * This namespace's builds, as a live collection: a bounded window (newest
 * first, 50 a page, at most 100) plus the `:rows` point sibling for by-id
 * reads.
 *
 * The server's base `where` scopes it to this backend's own namespace
 * (`server/internal/build-history-resource.ts`): a worktree DB is forked from
 * main and inherits main's rows. The projection is `BuildRunSchema`'s keys, so
 * the ledger's internal `pid` never reaches the wire.
 *
 * - The Build button, the popover, the build-activity hook and serve-status
 *   read the default window (`useLive(buildHistory)`) and look at its newest
 *   rows; none pages past it. The per-build artifact retention
 *   (`BUILD_ARTIFACTS_RETENTION`, infra/paths) is aligned with this 50, so
 *   every run in the default window keeps its profile and logs. `maxLimit` is
 *   twice the page only because every window is read as key-range pages, and
 *   a page that splits is read at `2 · default.limit`.
 * - A run's detail reads one row (`useLiveRow(buildHistory, runId)`), which
 *   reads the point sibling — so a run older than the newest 50 is still found
 *   (its pruned logs read as empty, never as broken).
 *
 * `preload: "boot"`: the boot snapshot hydrates the default window before first
 * paint, because the Build button's own state derives from it and that button
 * is first-paint chrome. A window is never L2-persisted, so a cold boot loads
 * its 50 rows fresh.
 */
export const buildHistory = liveCollection("build.history", {
  carry: { fields: BUILD_RUN_FIELDS },
  id: "id",
  sortable: ["startedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: 50 },
  maxLimit: 100,
  preload: "boot",
});
