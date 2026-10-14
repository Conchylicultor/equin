import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** A path the agent named that does not stay inside its own directory. */
export class WorkspaceEscapeError extends Error {
  constructor(path: string) {
    super(
      `${path} is outside your working directory; submit a file inside it (e.g. "score.musicxml").`,
    );
    this.name = "WorkspaceEscapeError";
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/**
 * Resolve a path an agent handed a tool to a file inside its workspace `root`,
 * relative to it (or absolute). Refuses anything that leaves `root` — by `..`,
 * an absolute path elsewhere, or a symlink pointing out — so a tool reading
 * "the agent's file" can never be made to read another. Throws (ENOENT) when
 * the file does not exist.
 */
export async function resolveWorkspaceFile(
  root: string,
  path: string,
): Promise<string> {
  const lexical = resolve(root, path);
  if (!inside(resolve(root), lexical)) throw new WorkspaceEscapeError(path);
  const real = await realpath(lexical);
  if (!inside(await realpath(root), real)) throw new WorkspaceEscapeError(path);
  return real;
}
