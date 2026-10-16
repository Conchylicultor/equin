import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  workspaceCatalog,
  type WorkspaceChoice,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";

/** Every workspace a task can name (preloaded, so ready at first paint). */
export function useWorkspaceCatalog(): ResourceResult<WorkspaceChoice[]> {
  return useLive(workspaceCatalog);
}

/**
 * The catalog choice a stored spec names: the worktree for `null` (the
 * option's default), else the same kind and profile. Input is not compared — a
 * stored spec carries its profile's parsed defaults, the catalog's `{}`.
 */
export function choiceFor(
  choices: readonly WorkspaceChoice[],
  spec: WorkspaceSpec | null,
): WorkspaceChoice | undefined {
  const want = spec ?? { kind: "worktree" as const };
  return choices.find((c) =>
    c.spec.kind === "scratch" && want.kind === "scratch"
      ? c.spec.profile === want.profile
      : c.spec.kind === want.kind,
  );
}
