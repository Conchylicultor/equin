import { useMemo } from "react";
import { locationOf } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import type { ExplorerLocation } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { convFileTreePane } from "../panes";

/**
 * Where the conversation's explorer is: the pane's `;dir` / `;open`, or the
 * checkout itself while no folder is named.
 */
export function useConvLocation(worktree: string): ExplorerLocation {
  const { dir, open } = convFileTreePane.useParams();
  return useMemo(
    () => locationOf({ dir: dir ?? worktree, open }),
    [dir, open, worktree],
  );
}
