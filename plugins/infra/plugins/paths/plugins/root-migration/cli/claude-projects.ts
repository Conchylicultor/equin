import { openSync, readSync, renameSync } from "node:fs";
import { adoptFd } from "@plugins/packages/plugins/owned-fd/core";
import {
  existsSync,
  readdirSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Move } from "./plan";
import { claudeProjectDirName } from "@plugins/infra/plugins/paths/core";
import { rewriteDbValue } from "./rewrite";

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

const CWD_FIELD = /"cwd":"((?:[^"\\]|\\.)*)"/;
const CHUNK = 64 * 1024;

/**
 * The cwd a transcript dir's sessions ran in: the first `cwd` field of its
 * first transcript, read chunk by chunk to wherever it is. Not the first 64 KiB
 * only — a session opened by a long prompt (a triage run's) writes its
 * `queue-operation` line, with no `cwd`, ahead of the first line that has one,
 * and 110 such dirs were left behind under the legacy root name by the
 * 2026-10 move.
 */
function sessionCwd(dir: string): string | null {
  const transcript = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
  if (transcript === undefined) return null;
  const fd = adoptFd(openSync(join(dir, transcript), "r"));
  try {
    const buf = Buffer.alloc(CHUNK);
    // A character split across two chunks is held back until it is whole.
    const utf8 = new StringDecoder("utf8");
    // Whole lines only: a `cwd` field never spans a newline, so the text
    // after the last newline is carried into the next chunk.
    let carry = "";
    for (let pos = 0; ;) {
      const n = readSync(fd.fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const text = carry + utf8.write(buf.subarray(0, n));
      const cut = text.lastIndexOf("\n");
      const match = CWD_FIELD.exec(cut === -1 ? "" : text.slice(0, cut));
      if (match?.[1] !== undefined)
        return JSON.parse(`"${match[1]}"`) as string;
      carry = cut === -1 ? text : text.slice(cut + 1);
    }
    const match = CWD_FIELD.exec(carry);
    return match?.[1] === undefined
      ? null
      : (JSON.parse(`"${match[1]}"`) as string);
  } finally {
    fd.close();
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
