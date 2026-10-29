import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * May watch the tasks it files: each task this agent files is watched by it,
 * and what happens in that task's subtree (agents starting, reports, flags,
 * the subtree going quiet) arrives as an event turn. `true` only — no grant,
 * no watching.
 */
export const watchChildren = defineCapability<true>({
  id: "watch.children",
  schema: z.literal(true),
  label: "Watch the tasks it files",
});

/**
 * The conversation running on the mandate's own root task watches the whole
 * tree: whatever happens under it that no nearer watcher takes, and the tree
 * going quiet, arrives as an event turn. Each new conversation on the root
 * takes the watch over (a relaunch or hand-off supervises in its place).
 * `true` only — no grant, no tree watch.
 */
export const watchTree = defineCapability<true>({
  id: "watch.tree",
  schema: z.literal(true),
  label: "Root conversation watches the tree",
});
