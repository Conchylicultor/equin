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
// Main now builds in a slot (`infra/git/main-slots`) — a linked worktree checked
// out at one commit, which no push writes into — so here the guard is a
// DETERMINISM check: a build of a commit must not change what that commit
// holds. The same reasoning applies; only the slot, not every pusher, pays.
//
// So a main build snapshots the tree before its first writer and compares after
// its last one (the formatter). A difference FAILS the build, naming every path
// it wrote and every untracked suspect. Nothing is restored: the slot is never
// served (the guard runs before the deploy), and the next build that takes it
// runs `git checkout --force` there, which resets every tracked path. (It used
// to restore every path the build dirtied, when main built in the checkout
// `./equin push` fast-forwards: a dirty file there failed every later main
// build and aborted every push's merge — 2026-11-04 a build raced a push's
// fast-forward and seedAuthoredOverrides rewrote 135 hand-authored `config/`
// overrides; 2026-11-16 a crashed build's half-written docs failed the next.)
// Untracked files are evidence, reported, never removed.
//
// A snapshot pair rather than a write-mode switch on every generator: one check
// after all writers catches every one of them, including ones not written yet.

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
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
 * Compare main's tree against `before`. Returns `null` when the build wrote
 * nothing git sees, else the full account to print. Never exits: the guard
 * fails the build on a non-null account (assertMainTreeUntouched).
 */
export async function describeMainTreeWrites(
  root: string,
  before: TreeSnapshot,
): Promise<string[] | null> {
  const drift = diffSnapshots(before, await snapshotTree(root));
  if (drift.written.length === 0) return null;

  const lines = [
    "ERROR: this build changed files git tracks in the commit it built.",
    "",
    "A main build is a function of its commit: every generated file in it was",
    "checked in sync by the push that landed it, so a difference means the build",
    "read an input that commit does not hold — usually a stray untracked file —",
    "or is not deterministic. Not deployed; the slot's next build resets it",
    "(`git checkout --force`).",
    "",
    "Written by this build:",
  ];
  for (const w of drift.written)
    lines.push(
      `  ${w.status} ${w.path}${w.wasClean ? "" : " (already dirty before the build)"}`,
    );
  if (drift.untracked.length > 0) {
    lines.push(
      "",
      "Untracked, not-ignored files in the checkout — the likely stray input:",
    );
    for (const p of drift.untracked) lines.push(`  ${p}`);
  }
  return lines;
}

/**
 * The guard, after the build's last writer: print the full account
 * (describeMainTreeWrites) and exit 1 when the build wrote anything git sees —
 * the build's exit hooks close its receipt and ledger row as failed, and the
 * backend keeps serving the previous deploy.
 */
export async function assertMainTreeUntouched(
  root: string,
  before: TreeSnapshot,
): Promise<void> {
  const account = await describeMainTreeWrites(root, before);
  if (account === null) return;
  console.error(account.join("\n"));
  process.exit(1);
}
