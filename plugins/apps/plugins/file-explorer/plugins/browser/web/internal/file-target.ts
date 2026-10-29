import type { PaneExpandTarget } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { workspaceRoot } from "@plugins/code-explorer/plugins/code-api/core";
import type { FileRef } from "@plugins/primitives/plugins/file-viewer/core";
import { displayPath } from "@plugins/infra/plugins/host-account/core";
import { joinPath, parentPath } from "../../core";
import { useHomeDir } from "./host-path-source";
import { useExplorerFolderTarget } from "../panes";

/**
 * Where Files shows `file` in full: its folder listed, the file previewed
 * beside it — as an Expand target (`Pane.define({ expand })`). A workspace
 * file is found through its workspace's root on this computer; a file Files
 * cannot reach (an app's data file, a workspace that no longer resolves)
 * answers `none`, so Expand falls back to the pane on its own, which shows
 * that read's own failure.
 */
export function useExplorerFileTarget(file: FileRef): PaneExpandTarget {
  const folderTarget = useExplorerFolderTarget();
  const home = useHomeDir();
  const root = useLive(
    workspaceRoot,
    file.source === "workspace" ? { worktree: file.workspace } : null,
  );
  if (file.source === "data") return { kind: "none" };
  if (home.kind === "pending") return { kind: "pending" };
  if (home.kind !== "ready") return { kind: "none" };
  let absolute: string;
  if (file.source === "host") {
    absolute = file.path;
  } else {
    switch (root.status) {
      case "loading":
        return { kind: "pending" };
      case "error":
      case "unavailable":
        return { kind: "none" };
      case "ready":
        absolute = joinPath(root.data.path, file.path);
    }
  }
  const open = displayPath(absolute, home.home);
  const dir = parentPath(open, home.home);
  if (dir === null) return { kind: "none" };
  return { kind: "ready", target: folderTarget(dir, open) };
}
