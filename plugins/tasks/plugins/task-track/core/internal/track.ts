import { z } from "zod";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";

/**
 * The closed set of task tracks, as plain data (not a registry — no plugin
 * adds a track):
 *
 * - `main`: on a feature's critical path — the feature is unfinished until it
 *   is done. Chained into the dependency graph and auto-started when an agent
 *   files them.
 * - `sidequest`: off the critical path (a follow-up, a caveat, a bug,
 *   cleanup — anything the feature can ship without). Runs
 *   after the task it was filed from, is never spliced into its chain and is
 *   never auto-started by an agent (a human may still arm one).
 */
export const TASK_TRACKS = ["main", "sidequest"] as const;
export const TaskTrackSchema = z.enum(TASK_TRACKS);
export type TaskTrack = z.infer<typeof TaskTrackSchema>;

/**
 * The track field's declared default — what a task with no track row is on.
 * The default is a real value, not a stand-in for "unknown": every task filed
 * before tracks existed, and every filing path that does not choose (the
 * draft form, Improve, the chain endpoint), is main-track. Only a non-default
 * track is stored (`setTaskTrack` deletes the row on main).
 */
export const DEFAULT_TASK_TRACK = "main" satisfies TaskTrack;

/**
 * How each track presents — the one source every badge reads, so the task
 * list, the task detail and the conversation header cannot disagree.
 * `variant` is the Badge / enum-chip tint (the conversation header's chip is
 * muted, so it takes only the label).
 */
export const TRACK_META: Record<
  TaskTrack,
  { label: string; hint: string; variant: BadgeVariant }
> = {
  main: {
    label: "Main",
    hint: "Main track: on the feature's critical path, chained and auto-started.",
    variant: "primary",
  },
  sidequest: {
    label: "Sidequest",
    hint: "Sidequest: off the critical path. Never spliced into the chain, never auto-started by an agent.",
    variant: "info",
  },
};
