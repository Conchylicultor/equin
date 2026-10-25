import { resolve, sep } from "node:path";
import type { EditedFile, EditedFileStatus } from "../../core/protocol";
import {
  parseDiffRawNumstatZ,
  runGit,
} from "@plugins/primitives/plugins/commit-list/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import type { EditedFilesFacts } from "./edited-files-signature";

const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024;

interface FileEntry {
  status: EditedFileStatus;
  additions: number;
  deletions: number;
  from?: string;
}

function isPathInside(root: string, target: string): boolean {
  const rootNorm = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(rootNorm);
}

async function countUntrackedLines(
  worktreePath: string,
  relPath: string,
): Promise<number> {
  const absRoot = resolve(worktreePath);
  const absTarget = resolve(absRoot, relPath);
  if (!isPathInside(absRoot, absTarget)) return 0;
  const file = Bun.file(absTarget);
  if (!(await file.exists())) return 0;
  if (file.size > UNTRACKED_MAX_BYTES) return 0;
  const buf = new Uint8Array(await file.arrayBuffer());
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    if (buf[i] === 0) return 0;
  }
  if (buf.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) lines++;
  }
  if (buf[buf.length - 1] !== 0x0a) lines++;
  return lines;
}

function ensureEntry(
  byPath: Map<string, FileEntry>,
  path: string,
  status: EditedFileStatus,
): FileEntry {
  let entry = byPath.get(path);
  if (!entry) {
    entry = { status, additions: 0, deletions: 0 };
    byPath.set(path, entry);
  }
  return entry;
}

// The un-memoized, gated compute — the VALUE half of the `edited-files` watched
// memo (edited-files-cache.ts). It reads the branch diff and line counts LIVE,
// and takes the merge-base and the dirty entries from `facts` — the one status
// scan its pass (or probe) already read — so a compute never re-walks the tree.
//
// This module is a LEAF on purpose: the memo declaration imports it, so it must
// never import the memo back (import cycle).
export async function computeEditedFiles(
  worktreePath: string,
  facts: EditedFilesFacts,
): Promise<EditedFile[]> {
  return withHeavyReadSlot(async () => {
    const byPath = new Map<string, FileEntry>();

    // A git failure here must NOT be conflated with "no changes" — an empty diff
    // would publish a false-empty edited-files list that a destructive
    // "Drop & Close" then acts on. runGit throws on failure; the throw reaches
    // the memo, which demotes and lets the loader raise it.
    //
    // ONE diff: -M / -C rename/copy detection, --raw for each path's status,
    // --numstat for its counts (both committed branch changes and uncommitted
    // working-tree edits, against the merge-base); -z keeps paths raw.
    const diff = await runGit(
      ["diff", "-M", "-C", "-z", "--raw", "--numstat", facts.mergeBase],
      worktreePath,
    );
    for (const rec of parseDiffRawNumstatZ(diff)) {
      byPath.set(rec.path, {
        status: rec.status,
        additions: rec.additions,
        deletions: rec.deletions,
        ...(rec.from ? { from: rec.from } : {}),
      });
    }

    // Working-tree changes are layered on top of the branch diff. The status
    // was read with --no-renames (uncommitted renames degrade to add+delete)
    // and -z, so its paths are the diff's own — never C-quoted.
    for (const { code, path } of facts.dirty) {
      if (code === "??") {
        ensureEntry(byPath, path, "untracked");
      } else if (code.includes("D")) {
        const entry = ensureEntry(byPath, path, "deleted");
        entry.status = "deleted";
      } else if (code.includes("A")) {
        ensureEntry(byPath, path, "added");
      } else {
        ensureEntry(byPath, path, "modified");
      }
    }

    // Untracked files don't appear in numstat — count their lines as additions.
    await Promise.all(
      [...byPath.entries()].map(async ([path, entry]) => {
        if (entry.status !== "untracked") return;
        entry.additions = await countUntrackedLines(worktreePath, path);
      }),
    );

    return [...byPath.entries()]
      .map(([path, entry]) => ({
        path,
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        ...(entry.from ? { from: entry.from } : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
}
