import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";

export const BuildRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(["manual", "auto"]),
  commitHash: z.string().nullable(),
  // WHICH COMPOSITIONS this one invocation built: `[MAIN_COMPOSITION_ID]` for a
  // plain deploy, or the composition ids of a `build --composition a b` run. One
  // invocation is one shared build (one install, codegen, checks pass,
  // transcript, profile and verdict), so it is one row with N target chips.
  targets: z.array(z.string()),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  exitCode: z.number().int().nullable(),
});

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
  row: BuildRunSchema,
  id: "id",
  filterable: {},
  sortable: ["startedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: 50 },
  maxLimit: 100,
  preload: "boot",
});
