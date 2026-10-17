// The main checkout is READ-ONLY to its own build.
//
// Every generated file on main was checked in sync (`plugins-doc-in-sync`,
// `plugins-registry-in-sync`, …) by the push that landed it, so main's build
// has nothing legitimate to write to a path git sees — only to gitignored
// output (`.generated/`, the dists). When it does write one, main's checkout
// read an input no pushing worktree had: a stray untracked file left by an
// older build, or one a later `.gitignore` change stopped ignoring.
//
// Left in place, that write is not cosmetic. The next push's `git merge
// --ff-only` in this checkout aborts on it ("Your local changes … would be
// overwritten"), and so does every push after it, until a human cleans main —
// agents are rightly guarded from writing there. 2026-10-17: a stale
// `plugins/config_v2/web/internal/git-layer.generated.ts`, un-ignored by
// 25df26786e, made main's docgen list config_v2 as a `--shadow` user and
// blocked the fleet.
//
// So a main build snapshots the tree before its first writer and compares after
// its last one (the formatter). A difference FAILS the build, naming every path
// and every untracked suspect — and restores what is safe to restore, so the
// failure stays this build's and never becomes every pusher's. Safe means: clean
// before this build (no one's edit is lost) AND a generated artifact by
// `.gitattributes` (a pure function of committed sources, so HEAD's bytes are
// the right ones). Anything else is reported and left alone. Untracked files are
// never removed: they are the evidence.
//
// A snapshot pair rather than a write-mode switch on every generator: one check
// after all writers catches every one of them, including ones not written yet.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

const GIT_TIMEOUT_MS = 60_000;

/** One path git reports as differing from HEAD (or untracked, not ignored). */
export interface TreeEntry {
  /** The porcelain v1 XY code (`" M"`, `"??"`, `"D "`, …). */
  status: string;
  /** sha1 of the bytes on disk, or `null` when the path does not exist. */
  content: string | null;
}

/** Every dirty path, keyed by repo-relative path. A clean tree is empty. */
export type TreeSnapshot = ReadonlyMap<string, TreeEntry>;

/**
 * Parse `git status --porcelain=v1 -z` into `[status, path]` pairs. A rename or
 * copy carries its source as the next NUL field; only the destination is a
 * path on disk, so the source is skipped.
 */
export function parsePorcelainZ(out: string): Array<[string, string]> {
  const fields = out.split("\0");
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field === "") continue;
    const status = field.slice(0, 2);
    entries.push([status, field.slice(3)]);
    if (status.includes("R") || status.includes("C")) i++;
  }
  return entries;
}

export interface TreeDrift {
  /** Paths this build changed — absent, or with other bytes, in the before snapshot. */
  written: Array<{ path: string; status: string; wasClean: boolean }>;
  /** Untracked, not-ignored paths after the build: the likely stray inputs. */
  untracked: string[];
}

/** What changed between two snapshots; `written` empty = the build wrote nothing git sees. */
export function diffSnapshots(
  before: TreeSnapshot,
  after: TreeSnapshot,
): TreeDrift {
  const written: TreeDrift["written"] = [];
  for (const [path, entry] of after) {
    const prior = before.get(path);
    if (prior !== undefined && prior.content === entry.content) continue;
    written.push({ path, status: entry.status, wasClean: prior === undefined });
  }
  // A path dirty before and clean after: the build rewrote someone's edit back
  // to HEAD's bytes. Still a write, and the edit is gone — say so.
  for (const [path, prior] of before) {
    if (after.has(path)) continue;
    written.push({ path, status: prior.status, wasClean: false });
  }
  written.sort((a, b) => a.path.localeCompare(b.path));
  const untracked = [...after]
    .filter(([, e]) => e.status === "??")
    .map(([p]) => p)
    .sort();
  return { written, untracked };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function contentHash(file: string): string | null {
  if (!existsSync(file)) return null;
  return createHash("sha1").update(readFileSync(file)).digest("hex");
}

/** Every path git sees as differing from HEAD, with the bytes on disk hashed. */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const out = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const snapshot = new Map<string, TreeEntry>();
  for (const [status, path] of parsePorcelainZ(out)) {
    snapshot.set(path, { status, content: contentHash(join(root, path)) });
  }
  return snapshot;
}

/**
 * The subset of `paths` `.gitattributes` routes to a generated-artifact merge
 * driver (`merge=regen-*`) — the files a build derives from committed sources,
 * whose HEAD bytes are therefore exactly what main should hold.
 */
async function generatedPaths(
  root: string,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const out = await git(root, ["check-attr", "-z", "merge", "--", ...paths]);
  // `-z` output: path NUL attr NUL value NUL, repeated.
  const fields = out.split("\0");
  const generated = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2]!.startsWith("regen-")) generated.add(fields[i]!);
  }
  return generated;
}

/**
 * Compare main's tree after the build's last writer against `before`. Returns
 * normally when the build wrote nothing git sees. Otherwise restores the safe
 * subset (see the file comment), prints the full account and exits 1 — the
 * build's exit hooks close its receipt and ledger row as failed, and the backend
 * keeps serving the previous deploy.
 */
export async function assertMainTreeUntouched(
  root: string,
  before: TreeSnapshot,
): Promise<void> {
  const drift = diffSnapshots(before, await snapshotTree(root));
  if (drift.written.length === 0) return;

  const generated = await generatedPaths(
    root,
    drift.written.map((w) => w.path),
  );
  const restorable = drift.written.filter(
    (w) => w.wasClean && w.status !== "??" && generated.has(w.path),
  );
  const kept = drift.written.filter((w) => !restorable.includes(w));
  if (restorable.length > 0) {
    await git(root, [
      "checkout",
      "HEAD",
      "--",
      ...restorable.map((w) => w.path),
    ]);
  }

  const lines = [
    "ERROR: this build changed files git tracks on main.",
    "",
    "Main's checkout is read-only to its own build: every generated file here was",
    "checked in sync by the push that landed it, so a difference means this checkout",
    "read an input no pushing worktree had — usually a stray untracked file left by an",
    "older build, or one a later .gitignore change stopped ignoring. Left in place, the",
    "change would make every push's merge into main abort.",
  ];
  if (restorable.length > 0) {
    lines.push(
      "",
      "Written by this build, restored to HEAD (generated artifacts):",
    );
    for (const w of restorable) lines.push(`  ${w.status} ${w.path}`);
  }
  if (kept.length > 0) {
    lines.push(
      "",
      "Written by this build, NOT restored (not a generated artifact, or already",
      "modified before the build — restoring could lose someone's edit):",
    );
    for (const w of kept) lines.push(`  ${w.status} ${w.path}`);
  }
  if (drift.untracked.length > 0) {
    lines.push(
      "",
      "Untracked, not-ignored files in main's checkout — the likely stray input",
      "(not removed; delete or ignore the one that does not belong):",
    );
    for (const p of drift.untracked) lines.push(`  ${p}`);
  }
  console.error(lines.join("\n"));
  process.exit(1);
}
