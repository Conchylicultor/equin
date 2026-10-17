import type { FileRef } from "./file-ref";

/**
 * The FileRef for a path as a conversation, a tool call or a markdown document
 * spells it — relative to a workspace, absolute, or `~`-prefixed — so whatever
 * reads it goes to the source that actually serves it:
 *
 * - relative → `workspace` (the code-api `:worktree` id);
 * - absolute and inside `opts.root` (the workspace's absolute root, when the
 *   caller knows it) → `workspace`, relativized;
 * - any other absolute or `~` path → `host` (infra/host-fs, which expands `~`).
 *
 * A `~` path is never matched against `root`: the browser cannot expand it,
 * and its bytes read the same from the host. Callers that only hold an id
 * (`"main"`, an attempt id) and no root send every absolute path to the host.
 */
export function fileRefForPath(
  workspace: string,
  path: string,
  opts: { root?: string } = {},
): FileRef {
  if (path === "~" || path.startsWith("~/")) return { source: "host", path };
  if (!path.startsWith("/")) return { source: "workspace", workspace, path };
  const abs = normalizeAbsolute(path);
  if (opts.root !== undefined) {
    const root = normalizeAbsolute(opts.root);
    const prefix = root === "/" ? "/" : `${root}/`;
    if (abs.startsWith(prefix) && abs.length > prefix.length) {
      return {
        source: "workspace",
        workspace,
        path: abs.slice(prefix.length),
      };
    }
  }
  return { source: "host", path: abs };
}

/** `.`/`..`/empty segments collapsed and any trailing slash dropped. */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
