import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";

/** The project's Claude Code memory directory, keyed by the main checkout. */
export async function memoryDir(): Promise<string> {
  const root = await ensureMainWorktreeRoot();
  const projectKey = root.replace(/[/_]/g, "-");
  return join(CLAUDE_PROJECTS_DIR, projectKey, "memory");
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The closest existing folder above `dir` — normally the project folder
 * (`<projects>/<key>`), which Claude Code creates on the checkout's first
 * session; `<projects>` itself (or above) for a checkout that never ran one.
 */
async function nearestExistingAncestor(dir: string): Promise<string> {
  let candidate = dirname(dir);
  while (!(await isDir(candidate))) {
    const up = dirname(candidate);
    if (up === candidate) return candidate;
    candidate = up;
  }
  return candidate;
}

/**
 * Hear the memory directory's direct entries change (those `matches` keeps)
 * until the returned release runs — through the shared dir hub.
 *
 * A read never creates anything: the folder belongs to Claude Code, which
 * creates it on its first memory. So the watch is a subtree watch of the
 * closest folder ABOVE it that exists, filtered to the memory folder itself
 * (created or removed, which moves every answer under it) and its direct
 * entries. A project with no memory yet answers `{ files: [] }` and still
 * hears its first memory file land.
 */
export async function watchMemoryDir(
  matches: (name: string) => boolean,
  notify: () => void,
): Promise<() => void> {
  const dir = await memoryDir();
  const release = await acquireDirWatch({
    dir: await nearestExistingAncestor(dir),
    scope: "subtree",
    onChange: (events) => {
      if (
        events.some(
          (e) =>
            e.path === dir ||
            // A parent created or removed carries the folder with it.
            dir.startsWith(`${e.path}/`) ||
            (dirname(e.path) === dir && matches(basename(e.path))),
        )
      ) {
        notify();
      }
    },
  });
  // A write between the first load and the watch opening produced no event;
  // one re-read closes that gap.
  notify();
  return release;
}
