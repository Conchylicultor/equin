import { z } from "zod";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { pluginTreeDeltaSchema } from "@plugins/plugin-meta/plugins/plugin-tree/core";

// The faceted-tree worker's frames (`bin/faceted-tree-worker.ts`, started by
// `machine/`). Plain data, structured-cloned — and PARSED on arrival, by the
// schemas the types below are derived from.
//
// Why parsed: the two ends do not always run the same code. The worker is
// loaded from the checkout when it is spawned; the backend runs the code it
// started with. Between a checkout moving and the backend's restart (main:
// the merge, then minutes of build; a worktree: any edit before its build), a
// session opened by the old backend talks to a worker of the new code. A
// frame that no longer matches is refused at the boundary, naming the field
// (`ProtocolSkew`, `machine/`), instead of crashing whatever read it first
// (2026-11-15: `frame.start.kind` on a `ready` frame that had lost `start`).
// Unknown fields are stripped, so a field ADDED on one side is no skew.

const toWorkerFrameSchema = z.discriminatedUnion("type", [
  /** Build the index of the checkout at `root` (first frame, once). */
  z.object({ type: z.literal("init"), root: z.string() }),
  /** One watcher batch, repo-relative (see `LiveRepoSnapshot.refresh`). */
  z.object({
    type: z.literal("refresh"),
    id: z.number(),
    paths: wholeList(z.string(), {
      reason:
        "one watcher batch — the backend ends the session past 2,000 paths",
    }),
    edited: wholeList(z.string(), {
      reason:
        "one watcher batch — the backend ends the session past 2,000 paths",
    }),
  }),
]);

const fromWorkerFrameSchema = z.discriminatedUnion("type", [
  /**
   * The structure tree (every node, no facets), whole: once as soon as the
   * cold build has it — before the facets, so a structure reader never waits
   * for them — then within each refresh that moved it, ahead of that
   * refresh's `refreshed`.
   */
  z.object({ type: z.literal("structure"), delta: pluginTreeDeltaSchema }),
  /**
   * The index is built: its facets (the whole tree, or why they failed — the
   * structure is held either way).
   */
  z.object({
    type: z.literal("ready"),
    facets: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("built"), delta: pluginTreeDeltaSchema }),
      z.object({ kind: z.literal("failed"), message: z.string() }),
    ]),
    ms: z.number(),
    /** Each build step's end, ms from the build's start (`FacetedIndex.steps`). */
    steps: wholeRecord(z.number(), {
      reason: "one entry per build step — a closed set of eight",
    }),
  }),
  z.object({
    type: z.literal("refreshed"),
    id: z.number(),
    ms: z.number(),
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("unchanged") }),
      z.object({
        kind: z.literal("changed"),
        delta: pluginTreeDeltaSchema,
        nodes: z.number(),
      }),
      z.object({ kind: z.literal("facets-failed"), message: z.string() }),
      z.object({ kind: z.literal("facets-retry") }),
      z.object({ kind: z.literal("code-changed"), path: z.string() }),
    ]),
  }),
  /**
   * The init (`id` null) or a refresh failed: the index is not usable — its
   * snapshot or structure failed (a facets failure is a `facets` outcome) —
   * or the worker could not read a frame the backend sent (`ProtocolSkew`'s
   * other direction).
   */
  z.object({
    type: z.literal("failed"),
    id: z.number().nullable(),
    message: z.string(),
  }),
]);

export type ToWorkerFrame = z.infer<typeof toWorkerFrameSchema>;
export type FromWorkerFrame = z.infer<typeof fromWorkerFrameSchema>;

/** A frame as one end read it: parsed, or why it does not match this code. */
export type FrameRead<T> =
  { ok: true; frame: T } | { ok: false; issue: string };

function read<T>(schema: z.ZodType<T>, data: unknown): FrameRead<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, frame: parsed.data };
  const issue = parsed.error.issues[0];
  const type =
    typeof data === "object" && data !== null && "type" in data
      ? String((data as { type: unknown }).type)
      : "?";
  return {
    ok: false,
    issue: `a "${type}" frame does not match this code's protocol${
      issue === undefined
        ? ""
        : ` at ${issue.path.length > 0 ? issue.path.join(".") : "its root"}: ${issue.message}`
    }`,
  };
}

/** A frame from the backend, read by the worker. */
export const readToWorkerFrame = (data: unknown): FrameRead<ToWorkerFrame> =>
  read(toWorkerFrameSchema, data);

/** A frame from the worker, read by the backend. */
export const readFromWorkerFrame = (
  data: unknown,
): FrameRead<FromWorkerFrame> => read(fromWorkerFrameSchema, data);
