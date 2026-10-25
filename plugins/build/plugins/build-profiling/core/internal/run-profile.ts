import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The most spans one profile may hold. A build records one span per pipeline
 * step — preflight, setup, each codegen task, each check, each frontend and
 * deploy step — so the count follows the repo's build pipeline, never user
 * data: ~220 today (161 of them checks). Ten times that is room for the
 * pipeline to grow; a profile past it fails its parse loudly rather than
 * shipping an unbounded list.
 */
const RUN_PROFILE_MAX_SPANS = 2000;

const BuildProfileSpanSchema = z.object({
  id: z.string(),
  phase: z.string(),
  label: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  /** Peak RSS (bytes) of the subprocess the span wrapped, when measured. */
  maxRssBytes: z.number().optional(),
});

const BuildRunProfileSchema = z.object({
  spans: cappedList(BuildProfileSpanSchema, { max: RUN_PROFILE_MAX_SPANS }),
  totalMs: z.number(),
});

/**
 * One build run's profiler spans — `build-profile-<buildId>.json`, which the
 * CLI writes once (tmp + rename), as its build ends — read from a worktree's
 * build artifacts on the computer's disk. `worktree` names whose; absent, the
 * serving backend's own namespace (the build detail pane's runs).
 *
 * Refusals: `missing` — no profile on disk for that run (still running, ended
 * before writing one, or pruned); `invalid-id` — a worktree that is no
 * namespace or a build id that is no single filename-safe segment (both are
 * joined into a path).
 */
export const buildRunProfile = liveValue("build.run-profile", {
  schema: BuildRunProfileSchema,
  params: ["buildId", "worktree?"],
  refusals: ["missing", "invalid-id"],
  needsMachine: { feature: "Build profiles" },
});
