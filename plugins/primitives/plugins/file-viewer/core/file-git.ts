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

/**
 * The file's lower-cased extension without the dot, or `""` when it has none.
 * A leading dot alone (`.gitignore`) is a name, not an extension.
 */
export function fileExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}
