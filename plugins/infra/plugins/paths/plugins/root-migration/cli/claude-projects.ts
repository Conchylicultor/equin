import {
  existsSync,
  openSync,
  readdirSync,
  readSync,
  closeSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { Move } from "./plan";
import { claudeProjectDirName, rewriteDbValue } from "./rewrite";

// Claude Code files a session's transcripts under a dir named for its cwd
// (`~/.claude/projects/<cwd, every non-alphanumeric as ->`), and a resumed
// session looks there for its cwd as the OS reports it — the physical path.
// A scratch conversation ran in a workspace under the data root, so once the
// root moves its cwd reads differently and the transcript would not be found.
// Each such dir is renamed to the name its cwd has now.
//
// Which dirs those are is read from the transcripts' own `cwd` field, not from
// the dir name: the name loses `/` and `.` (`~/.x-y` and `~/.x/y` encode alike),
// so matching names would also catch a sibling directory's sessions.

export interface ProjectRename {
  from: string;
  to: string;
  /** The target name already exists (a session ran there since): left for a human. */
  conflict: boolean;
}

/** The cwd a transcript dir's sessions ran in, from the first `cwd` field of its first transcript. */
function sessionCwd(dir: string): string | null {
  const transcript = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
  if (transcript === undefined) return null;
  const fd = openSync(join(dir, transcript), "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString("utf8", 0, n));
    return match?.[1] === undefined
      ? null
      : (JSON.parse(`"${match[1]}"`) as string);
  } finally {
    closeSync(fd);
  }
}

/**
 * The transcript dirs to rename for `moves`, read from `projectsDir`. With
 * `apply`, renames every one without a conflict.
 */
export function moveClaudeProjects(
  projectsDir: string,
  moves: readonly Move[],
  apply: boolean,
): ProjectRename[] {
  if (!existsSync(projectsDir)) return [];
  const prefixes = moves.map((m) => claudeProjectDirName(m.from));
  const renames: ProjectRename[] = [];
  for (const name of readdirSync(projectsDir)) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const dir = join(projectsDir, name);
    const cwd = sessionCwd(dir);
    if (cwd === null) continue;
    const moved = rewriteDbValue(cwd, moves);
    if (moved === null) continue;
    const to = join(projectsDir, claudeProjectDirName(moved));
    const conflict = existsSync(to);
    renames.push({ from: dir, to, conflict });
    if (apply && !conflict) renameSync(dir, to);
  }
  return renames;
}
