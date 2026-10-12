import { useCallback } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { buildProfileDetailPane } from "@plugins/debug/plugins/profiling/plugins/build/web";
import type { OpEntry } from "@plugins/debug/plugins/profiling/plugins/ops/plugins/op-gantt/web";
import { opDetailPane } from "../panes";

/**
 * The ONE `opActivation` dispatcher, shared by every OpGantt host (the Debug >
 * Profiling section and the per-conversation `/pp` pane). Both used to carry
 * their own copy of the build-vs-push branch, and the copies were already a
 * paste of each other — the same duplication that let build and push drift
 * apart everywhere else in this stack.
 *
 * Dispatch is on `kind`, and the asymmetry is real, not incidental: a build's
 * drill-in is its per-run span breakdown (`build-profile-<id>.json`), a separate
 * artifact joined to the op only by `buildId`. A push or a check has no such
 * artifact — its fine grain (waits + steps) IS the op record, so it opens the
 * generic op detail pane. Both are links (`openPane.to`), so ⌘/middle-click on
 * a bar opens its detail in a new browser tab.
 */
export function useOpActivation(): (
  op: OpEntry,
  worktree: string,
) => Activation {
  const openPane = useOpenPane();

  return useCallback(
    (op: OpEntry, worktree: string): Activation => {
      if (op.kind === "build") {
        // Builds logged before the buildId field have no profile to open. Handle
        // the click anyway (rather than not wiring one): the Gantt stops the
        // click from falling through to the row's worktreeActivation, so
        // silence here would read as a dead bar.
        const buildId = op.buildId;
        if (!buildId) {
          return () =>
            showToast({
              description:
                "No build profile for this build (logged before profiling).",
              variant: "info",
            });
        }
        return openPane.to(
          buildProfileDetailPane,
          { worktree, buildId },
          { mode: "push" },
        );
      }
      return openPane.to(opDetailPane, { opId: op.opId }, { mode: "push" });
    },
    [openPane],
  );
}
