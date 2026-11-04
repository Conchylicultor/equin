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
// and every untracked suspect — and restores every tracked path this build
// dirtied, so the failure stays this build's and never becomes every pusher's.
// Restorable means: clean before this build (it matched HEAD when the build
// started, so no one's edit can be lost) and present in HEAD (a modified or
// deleted tracked file, which `git checkout HEAD --` puts back). Whether the file
// is generated does not matter: 2026-11-04 a main build raced a push's
// fast-forward, codegen read a mixed tree, and seedAuthoredOverrides rewrote 135
// hand-authored `config/` overrides — restoring only `merge=regen-*` paths left
// them dirty and failed every later main build. Paths dirty before the build are
// reported and left alone; untracked files are never removed: they are the
// evidence.
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

/** Why a written path was left as it is rather than restored to HEAD. */
export type KeptReason =
  /** Dirty before this build: restoring could lose someone's edit. */
  | "dirty-before"
  /** No HEAD version to return to (untracked, added, renamed or copied to), or unmerged. */
  | "not-restorable";

export interface RestorePlan {
  /** Clean before the build and present in HEAD: `git checkout HEAD --` them. */
  restore: TreeDrift["written"];
  kept: Array<TreeDrift["written"][number] & { reason: KeptReason }>;
}

/**
 * Porcelain codes of a path that exists in HEAD and differs from it only by
 * modification, deletion or type change, in the index or the worktree — what
 * `git checkout HEAD -- <path>` returns to HEAD's bytes, index included.
 * Anything else (`??`, `A`, `R`, `C`, unmerged) names a path HEAD lacks or a
 * merge in progress.
 */
const RESTORABLE_SIDE = new Set([" ", "M", "D", "T"]);
function inHeadAndRestorable(status: string): boolean {
  return (
    status !== "  " &&
    RESTORABLE_SIDE.has(status[0]!) &&
    RESTORABLE_SIDE.has(status[1]!)
  );
}

/**
 * Split the build's writes into what to restore to HEAD and what to leave: a
 * pure function of the snapshot diff. Every path clean before the build that
 * HEAD holds is restored, generated or hand-authored alike.
 */
export function planRestore(written: TreeDrift["written"]): RestorePlan {
  const plan: RestorePlan = { restore: [], kept: [] };
  for (const w of written) {
    if (!w.wasClean) plan.kept.push({ ...w, reason: "dirty-before" });
    else if (!inHeadAndRestorable(w.status))
      plan.kept.push({ ...w, reason: "not-restorable" });
    else plan.restore.push(w);
  }
  return plan;
}

/**
 * Compare main's tree after the build's last writer against `before`. Returns
 * normally when the build wrote nothing git sees. Otherwise restores every
 * restorable write (planRestore; see the file comment), prints the full account and exits 1 — the
 * build's exit hooks close its receipt and ledger row as failed, and the backend
 * keeps serving the previous deploy.
 */
export async function assertMainTreeUntouched(
  root: string,
  before: TreeSnapshot,
): Promise<void> {
  const drift = diffSnapshots(before, await snapshotTree(root));
  if (drift.written.length === 0) return;

  const { restore, kept } = planRestore(drift.written);
  if (restore.length > 0) {
    await git(root, ["checkout", "HEAD", "--", ...restore.map((w) => w.path)]);
    // The restore is the guarantee this guard exists for: prove it held.
    const after = await snapshotTree(root);
    const stillDirty = restore.filter((w) => after.has(w.path));
    if (stillDirty.length > 0) {
      throw new Error(
        `main-tree guard: git checkout HEAD left ${stillDirty.length} path(s) dirty: ` +
          stillDirty.map((w) => w.path).join(", "),
      );
    }
  }

  const lines = [
    "ERROR: this build changed files git tracks on main.",
    "",
    "Main's checkout is read-only to its own build: every generated file here was",
    "checked in sync by the push that landed it, so a difference means this checkout",
    "read an input no pushing worktree had — usually a stray untracked file left by an",
    "older build, or one a later .gitignore change stopped ignoring — or the tree moved",
    "under the build (a push fast-forwarding main mid-build). Left in place, the",
    "change would make every push's merge into main abort.",
  ];
  if (restore.length > 0) {
    lines.push(
      "",
      "Written by this build, restored to HEAD (clean before the build):",
    );
    for (const w of restore) lines.push(`  ${w.status} ${w.path}`);
  }
  const dirtyBefore = kept.filter((w) => w.reason === "dirty-before");
  if (dirtyBefore.length > 0) {
    lines.push(
      "",
      "Written by this build, NOT restored (already modified before the build —",
      "restoring could lose someone's edit):",
    );
    for (const w of dirtyBefore) lines.push(`  ${w.status} ${w.path}`);
  }
  const notRestorable = kept.filter((w) => w.reason === "not-restorable");
  if (notRestorable.length > 0) {
    lines.push(
      "",
      "Written by this build, NOT restored (no HEAD version to return to — new,",
      "added or renamed — or unmerged; kept as evidence):",
    );
    for (const w of notRestorable) lines.push(`  ${w.status} ${w.path}`);
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
