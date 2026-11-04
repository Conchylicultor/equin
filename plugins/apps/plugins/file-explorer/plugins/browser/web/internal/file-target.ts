import type { PaneExpandTarget } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { workspaceRoot } from "@plugins/code-explorer/plugins/code-api/core";
import type { FileRef } from "@plugins/primitives/plugins/file-viewer/core";
import { displayPath } from "@plugins/infra/plugins/host-account/core";
import { joinPath, parentPath } from "../../core";
import { useHomeDir } from "./host-path-source";
import { useExplorerFolderTarget } from "../panes";

/**
 * Where `file` sits on this computer, in display form (`~/…` under home):
 * `pending` while the home folder or the workspace's root is still read;
 * `none` for a file Files cannot reach (an app's data file, a workspace that
 * no longer resolves, a host without the computer); else the file's `path`,
 * plus — for a workspace file — the workspace's `root`, and the `home` both
 * are relative to.
 */
export type FileHostPath =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "ready"; home: string; path: string; root?: string };

export function useFileHostPath(file: FileRef): FileHostPath {
  const home = useHomeDir();
  const root = useLive(
    workspaceRoot,
    file.source === "workspace" ? { worktree: file.workspace } : null,
  );
  if (file.source === "data") return { kind: "none" };
  if (home.kind === "pending") return { kind: "pending" };
  if (home.kind !== "ready") return { kind: "none" };
  if (file.source === "host") {
    return {
      kind: "ready",
      home: home.home,
      path: displayPath(file.path, home.home),
    };
  }
  switch (root.status) {
    case "loading":
      return { kind: "pending" };
    case "error":
    case "unavailable":
      return { kind: "none" };
    case "ready":
      return {
        kind: "ready",
        home: home.home,
        path: displayPath(joinPath(root.data.path, file.path), home.home),
        root: displayPath(root.data.path, home.home),
      };
  }
}

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
  const place = useFileHostPath(file);
  if (place.kind !== "ready") return place;
  const dir = parentPath(place.path, place.home);
  if (dir === null) return { kind: "none" };
  return { kind: "ready", target: folderTarget(dir, place.path) };
}
