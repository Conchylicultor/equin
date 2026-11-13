import {
  defineDataDir,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";

/**
 * The installed extension: main's build writes the shell framing main here,
 * and Chrome loads it unpacked from its `shell/` folder.
 */
export const browserExtensionDir = defineDataDir({
  kind: "state",
  name: "browser-extension",
  owner: "companions/browser-extension",
  description:
    "The browser extension main's build writes (shell/, loaded unpacked by Chrome), its digest, and when its popup last opened",
  reclaim: {
    kind: "never",
    reason:
      "Chrome loads the installed extension from shell/ by this path; removing it uninstalls the extension until the next main build",
  },
});

/**
 * Where a namespace's extension lives: main's in the data dir above (the one
 * the user installs), any other namespace's beside its build artifacts
 * (`~/.equin/worktrees/<ns>/browser-extension`, loaded unpacked only to try a
 * branch, and reclaimed with the namespace). Holds:
 *
 * - {@link SHELL_FOLDER}: the shell itself, replaced whole on each change;
 * - {@link SHELL_DIGEST_FILE}: that shell's digest, written after it (what the
 *   backend watches, so it is a stable path beside the swapped folder);
 * - {@link CONNECTION_FILE}: when the popup last opened, and on which shell.
 */
export function browserExtensionRoot(ns: Namespace): AppPath {
  return ns === MAIN_WORKTREE_NAME
    ? browserExtensionDir.path
    : joinAppPath(worktreeDataDir(ns), "browser-extension");
}

export const SHELL_FOLDER = "shell";
export const SHELL_DIGEST_FILE = "shell-digest.txt";
export const CONNECTION_FILE = "connection.json";

export default [browserExtensionDir];
