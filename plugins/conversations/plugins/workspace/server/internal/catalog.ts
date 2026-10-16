import { serveValue } from "@plugins/network/plugins/live/server";
import {
  WORKSPACE_KINDS,
  workspaceCatalog,
  type WorkspaceChoice,
} from "../../core";
import { ScratchProfile } from "./scratch-profile";

/**
 * Every workspace a task can name: the worktree, then one choice per scratch
 * profile. A profile whose input has no defaults (`{}` does not parse) is
 * listed but `unavailable` — only its own app can supply the input.
 */
export function listWorkspaceChoices(): WorkspaceChoice[] {
  const worktree = WORKSPACE_KINDS.worktree;
  const scratch = WORKSPACE_KINDS.scratch;
  return [
    {
      spec: { kind: "worktree" },
      kind: "worktree",
      label: worktree.label,
      description: worktree.description,
      capabilities: [...worktree.capabilities],
    },
    ...ScratchProfile.all().map((p): WorkspaceChoice => ({
      spec: { kind: "scratch", profile: p.id, input: {} },
      kind: "scratch",
      label: p.label,
      description: p.description,
      capabilities: [...scratch.capabilities],
      profile: {
        id: p.id,
        owner: ScratchProfile.ownerOf(p.id),
        mcpToolCount: p.mcpTools.length,
      },
      unavailable: p.inputSchema.safeParse({}).success
        ? undefined
        : "Needs input — started from its own app",
    })),
  ];
}

// External: the truth is the in-process registries, which settle in the
// register phase and never change while the process runs.
export const workspaceCatalogServed = serveValue(workspaceCatalog, {
  source: "external",
  changes: {
    fixed: { reason: "workspace kinds and scratch profiles register at boot" },
  },
  loader: () => listWorkspaceChoices(),
});
