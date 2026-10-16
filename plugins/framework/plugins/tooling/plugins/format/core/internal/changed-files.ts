// The changed-file set, computed ONCE and shared by every consumer: the build's
// format pass, `./singularity format`, and the `format-clean` check. If the
// writer and the checker computed different sets, the build would format one
// set and the check would assert another.
//
// Idiom ported from
// `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/compute-edited-files.ts`,
// over `spawnCaptured` (raw `Bun.spawn` is lint-banned, and `git-read-cache` is
// server-only so it is unreachable from here).

import { existsSync } from "fs";
import { join } from "path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { ChangedFile } from "./line-scope";
import { COUPLED_FORMAT_SETS, isFormattable } from "./prettier";

// Wedge-breaker for the metadata-only git reads below (`status`, `diff
// --name-only`, `merge-base`) — orders of magnitude above what they take, so
// only a genuinely wedged child trips it. Generous rather than tight because
// what these suffer on a loaded box is starvation, not slowness; `infra/worktree`'s
// bounds carry the measurements behind that choice.
const GIT_TIMEOUT_MS = 60_000;

async function git(root: string, args: string[]): Promise<string> {
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${root} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/** Split a `-z` (NUL-separated) git output into its records, dropping the trailing empty. */
function splitNul(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

/**
 * Untracked paths, from `git status --porcelain -z`. Every other change against
 * the merge-base is in `git diff <base>`, which compares the base with the
 * working tree (staged and unstaged alike); only a file git does not track yet
 * is invisible to it.
 */
function parseUntrackedZ(out: string): string[] {
  return splitNul(out)
    .filter((rec) => rec.startsWith("?? "))
    .map((rec) => rec.slice(3));
}

/**
 * `git diff -M -z --name-status` records: `M\0path`, `A\0path`, and for a
 * rename or copy `R<score>\0old\0new`. Maps each current path to the path its
 * bytes had at the base, or `null` when the base has no such file.
 */
function parseNameStatusZ(out: string): Map<string, string | null> {
  const records = splitNul(out);
  const origins = new Map<string, string | null>();
  for (let i = 0; i < records.length; i++) {
    const status = records[i]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      origins.set(records[i + 2]!, records[i + 1]!);
      i += 2;
    } else {
      origins.set(records[i + 1]!, status === "A" ? null : records[i + 1]!);
      i += 1;
    }
  }
  return origins;
}

/**
 * Expand each coupled set that the changed set touches to ALL of its members.
 *
 * A member that no longer exists on disk is dropped: a coupled set names files
 * the check that needs them held together also names, and that check fails
 * loudly on exactly that drift — formatting must not ENOENT-crash the build
 * ahead of the check that can actually explain it. (`COUPLED_FORMAT_SETS` is
 * empty today; see its doc-comment.)
 *
 * Returns every member of a touched set: they are formatted whole, since a set
 * held byte-identical cannot be formatted line by line, each by its own diff.
 */
function expandCoupledSets(root: string, files: Set<string>): string[] {
  const members: string[] = [];
  for (const set of COUPLED_FORMAT_SETS) {
    if (!set.some((member) => files.has(member))) continue;
    for (const member of set) {
      if (existsSync(join(root, member))) {
        files.add(member);
        members.push(member);
      }
    }
  }
  return members;
}

/**
 * Formattable files changed vs `merge-base(HEAD, main)` (committed, staged,
 * unstaged or untracked), each with its {@link FormatScope}, sorted by path.
 *
 * A file the base has is scoped to the lines that differ from its bytes there
 * (its rename origin's); a file the base lacks, and every member of a coupled
 * set, is scoped to the whole file.
 *
 * On `main`, `merge-base(HEAD, main) === HEAD`, so the set is just the dirty and
 * untracked files.
 */
export async function listChangedFormattableFiles(
  root: string,
): Promise<ChangedFile[]> {
  // A git failure here must NOT be conflated with "no merge-base": a
  // manufactured fallback ref (or an absorbed empty diff) would silently format
  // nothing and let `format-clean` fail later with no explanation.
  const base = (await git(root, ["merge-base", "HEAD", "main"])).trim();
  if (base.length === 0) {
    throw new Error(`git merge-base HEAD main produced no sha in ${root}`);
  }

  // -M resolves renames to the new path; --diff-filter=ACMR excludes deletions.
  const origins = parseNameStatusZ(
    await git(root, [
      "diff",
      "-M",
      "-z",
      "--name-status",
      "--diff-filter=ACMR",
      base,
    ]),
  );

  // An agent's brand-new `.tsx` is invisible to the diff above. `git status`
  // honors `.gitignore`, so `node_modules/` and `dist/` are excluded for free.
  const status = await git(root, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  for (const path of parseUntrackedZ(status)) {
    if (!origins.has(path)) origins.set(path, null);
  }

  const files = new Set(origins.keys());
  const whole = new Set(
    [...origins].filter(([, origin]) => origin === null).map(([p]) => p),
  );
  for (const member of expandCoupledSets(root, files)) whole.add(member);

  const changed: ChangedFile[] = [];
  for (const file of [...files].filter(isFormattable).sort()) {
    const origin = origins.get(file);
    changed.push({
      file,
      scope:
        whole.has(file) || origin === undefined || origin === null
          ? { kind: "file" }
          : {
              kind: "lines",
              // Bytes at the base, exactly: `git show` adds no trailing newline.
              base: await git(root, ["show", `${base}:${origin}`]),
            },
    });
  }
  return changed;
}
