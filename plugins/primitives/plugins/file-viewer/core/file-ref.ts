/**
 * What a file viewer shows: one file, named by WHERE its bytes live.
 *
 * - `host` — an absolute path on the user's machine, read through infra/host-fs.
 * - `workspace` — a path relative to a workspace's root (`workspace` is the id
 *   the `/api/code/:worktree/*` routes take: an attempt id of any workspace
 *   kind, `"main"`, `"self"`, or a checkout's absolute root). Read as it is on
 *   disk right now, or AS OF `ref` when given — a git read, so only a checkout
 *   answers one.
 *
 * Renderers receive a `FileRef` and hand it straight to `useFileText` /
 * `fileUrl`; they never branch on `source` to read it.
 */
export type FileRef =
  | { source: "host"; path: string }
  | { source: "workspace"; workspace: string; ref?: string; path: string };

/**
 * How a file stands against its checkout's base — the context that lights up a
 * contextual renderer (the Diff tab). The same closed set `git status` reports;
 * `clean` and absent both mean "nothing to diff".
 */
export type FileGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "copied"
  | "clean";

/**
 * Git context for a previewed file, independent of where its bytes come from.
 * `checkout` is the code-api `:worktree` id (`"main"`, `"self"`, an attempt id,
 * or an absolute checkout root); `path` is relative to that checkout.
 */
export interface FileViewerGit {
  checkout: string;
  path: string;
  status: FileGitStatus;
}

/** The file's basename. */
export function fileRefName(file: FileRef): string {
  return file.path.slice(file.path.lastIndexOf("/") + 1);
}

/**
 * The file's lower-cased extension without the dot, or `""` when it has none.
 * A leading dot alone (`.gitignore`) is a name, not an extension.
 */
export function fileExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}

/**
 * One string that identifies the file a ref names — for React keys and for
 * resetting per-file state (the active renderer tab) when the file changes.
 */
export function fileRefKey(file: FileRef): string {
  return file.source === "host"
    ? `host:${file.path}`
    : `workspace:${file.workspace}:${file.ref ?? ""}:${file.path}`;
}
