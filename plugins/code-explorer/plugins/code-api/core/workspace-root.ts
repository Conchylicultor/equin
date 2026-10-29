import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { CODE_MACHINE } from "./endpoints";

export const WorkspaceRootSchema = z.object({
  /** The workspace's root on this computer, absolute. */
  path: z.string().min(1),
  /** Whether it is a git checkout (a scratch dir is not). */
  git: z.boolean(),
});
export type WorkspaceRootInfo = z.infer<typeof WorkspaceRootSchema>;

/**
 * Where the workspace `worktree` names lives on this computer — the same
 * resolve every code.* read runs (an attempt id of any workspace kind,
 * `"main"`, `"self"`, or a checkout's absolute toplevel). For a surface that
 * hands a workspace file to something reading host paths (Files). Pushed from
 * the attempt row (an attempt's root is set when it is made and never
 * rewritten; the row appearing moves `no-workspace` to the root). Refused:
 * `no-workspace`.
 */
export const workspaceRoot = liveValue("code.workspace-root", {
  schema: WorkspaceRootSchema,
  params: ["worktree"],
  refusals: ["no-workspace"],
  needsMachine: CODE_MACHINE,
});
