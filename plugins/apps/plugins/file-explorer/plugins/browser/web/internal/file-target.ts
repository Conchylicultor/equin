import type { PaneExpandTarget } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { workspaceRoot } from "@plugins/code-explorer/plugins/code-api/core";
import type {
  BrowsableFileSystem,
  FileLocation,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { displayPath } from "@plugins/infra/plugins/host-account/core";
import { joinPath, parentPath } from "../../core";
import { useHomeDir } from "./host-path-source";
import { useExplorerFolderTarget } from "../panes";

/**
 * Where `file` sits in a file system Files browses, in display form (`~/…`
 * under that system's home): `pending` while the home folder or the
 * workspace's root is still read; `none` for a file Files cannot reach (a
 * workspace that no longer resolves, a computer file on a host without the
 * computer); else the system (`fs` — a checkout's files are on the
 * computer's disk) and the file's `path`, plus — for a checkout file — the
 * checkout's `root`, and the `home` both are relative to.
 */
export type FileHostPath =
  | { kind: "pending" }
  | { kind: "none" }
  | {
      kind: "ready";
      fs: BrowsableFileSystem;
      home: string;
      path: string;
      root?: string;
    };

export function useFileHostPath(file: FileLocation): FileHostPath {
  const home = useHomeDir();
  const root = useLive(
    workspaceRoot,
    file.fs === "checkout" ? { worktree: file.checkout } : null,
  );
  // The browser's storage: its home is its root.
  if (file.fs === "browser") {
    return {
      kind: "ready",
      fs: "browser",
      home: "/",
      path: displayPath(file.path, "/"),
    };
  }
  if (home.kind === "pending") return { kind: "pending" };
  if (home.kind !== "ready") return { kind: "none" };
  if (file.fs === "computer") {
    return {
      kind: "ready",
      fs: "computer",
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
        fs: "computer",
        home: home.home,
        path: displayPath(joinPath(root.data.path, file.path), home.home),
        root: displayPath(root.data.path, home.home),
      };
  }
}

/**
 * Where Files shows `file` in full: its folder listed, the file previewed
 * beside it — as an Expand target (`Pane.define({ expand })`). A checkout
 * file is found through its checkout's root on this computer; a file Files
 * cannot reach (a workspace that no longer resolves)
 * answers `none`, so Expand falls back to the pane on its own, which shows
 * that read's own failure.
 */
export function useExplorerFileTarget(file: FileLocation): PaneExpandTarget {
  const folderTarget = useExplorerFolderTarget();
  const place = useFileHostPath(file);
  if (place.kind !== "ready") return place;
  const dir = parentPath(place.path, place.home);
  if (dir === null) return { kind: "none" };
  return { kind: "ready", target: folderTarget(place.fs, dir, place.path) };
}
