// The guard's trust anchor. `./guard.ts` and this file import NOTHING from the
// repo — `node:` builtins only (`guards:bootstrap-builtins-only`) — because
// everything else they could import lives in the checkout the agent is editing.
// See "The guard survives a broken checkout" in ../CLAUDE.md.

import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** What the bootstrap prints and how it exits. */
export type BootstrapResult =
  { ok: true; stdout: string } | { ok: false; stderr: string };

/** A guard run that either printed its verdict or failed with an explanation. */
export type GuardRun =
  { ok: true; stdout: string } | { ok: false; error: string };

/** Where main's guard is, for a live guard that cannot run. */
export interface Fallback {
  /** The checkout whose guard failed, and main's — both named in the notice. */
  liveRoot: string;
  mainRoot: string;
  run(): Promise<GuardRun>;
}

const MAX_ERROR_CHARS = 2000;

/**
 * The install stamp `ensureDeps` writes (its `STAMP_REL`), relative to the
 * checkout root. A copy, because this file may import nothing from the repo;
 * `bootstrap.test.ts` asserts the two are equal.
 */
export const INSTALL_STAMP_REL = join("node_modules", ".equin-deps");

/** A checkout with no install stamp: its own guard would resolve npm packages from main's tree. */
export class CheckoutNotInstalledError extends Error {
  constructor(root: string) {
    super(
      `this checkout is not installed (no ${INSTALL_STAMP_REL} in ${root}) — run any ./equin command`,
    );
    this.name = "CheckoutNotInstalledError";
  }
}

/**
 * The checkout holding `script`: the nearest directory above it with a `.git`
 * (a dir in main, a file in a linked worktree). Read from disk, not git, so the
 * live path costs a few stats.
 */
export function checkoutRootOf(script: string): string {
  for (let dir = dirname(script); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir)
      throw new Error(`no checkout (.git) above ${script}`);
  }
}

/**
 * Throws {@link CheckoutNotInstalledError} when the checkout holding `script`
 * has no install stamp. Presence only, not freshness: a stale install is still
 * the checkout's own, while an absent one makes Bun walk up out of the checkout
 * into main's `node_modules` — a cryptic `Cannot find package` at best, a guard
 * running on main's copy of a package at worst.
 */
export function assertCheckoutInstalled(script: string): void {
  const root = checkoutRootOf(script);
  if (!existsSync(join(root, INSTALL_STAMP_REL)))
    throw new CheckoutNotInstalledError(root);
}

// ── The main-slot lease ─────────────────────────────────────────────────────
//
// A guard run from one of main's slots (infra/git/main-slots) — a scratch
// agent's, whose GUARDS_ROOT is main's `current` link — loads its code from a
// checkout a build may check out again once nothing holds it. So before the
// dynamic import, the bootstrap holds the slot shared: one `open(…, O_SHLOCK)`
// of the slot's lock file (the flock every main-slots lease takes; a build's
// exclusive lease waits for it, and it waits for a build) and a holder record
// beside it, kind `guard`. Copies of main-slots/boot-lease's layout, because
// this file may import nothing from the repo; `bootstrap.test.ts` holds each
// to the original.

/** `LEGACY_IDS.gitLockDir` (framework/product-name): the app's dir inside a git dir. */
export const GIT_LOCK_DIR = "singularity-locks";
/** boot-lease's `SLOT_LOCK_FILE`. */
export const SLOT_LOCK_FILE = "tree.lock";
/** boot-lease's `SLOT_LEASES_DIR`. */
export const SLOT_LEASES_DIR = "leases";
/** boot-lease's `MAIN_SLOT_STAMP`. */
export const MAIN_SLOT_STAMP = "main-slot";
/** boot-lease's `MAIN_SLOT_SERVED_FILE`. */
export const MAIN_SLOT_SERVED_FILE = "main-slot-served";
/** boot-lease's `O_SHLOCK_DARWIN`. */
export const O_SHLOCK_DARWIN = 0x10;

/** The admin dir (`<git dir>/<lock dir>`) of the checkout at `root`, or null for no checkout. */
export function adminDirOf(root: string): string | null {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return join(dotGit, GIT_LOCK_DIR);
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
  if (match === null)
    throw new Error(`${dotGit} is a file but names no "gitdir:"`);
  const gitDir = isAbsolute(match[1]!) ? match[1]! : join(root, match[1]!);
  return join(gitDir, GIT_LOCK_DIR);
}

/** A hold on the slot a guard runs from; `release` is a no-op outside a main slot. */
export interface GuardLease {
  slot: string | null;
  release(): void;
}

/**
 * Hold the main slot holding `script` shared (waiting, in the open, while a
 * build holds it) and record it — or nothing, when its checkout is no main
 * slot (a worktree, main's repo root). Throws when the lock cannot be taken:
 * the caller's live run fails, and main's guard judges instead.
 */
export function holdGuardLease(script: string): GuardLease {
  const root = checkoutRootOf(realpathSync(script));
  const admin = adminDirOf(root);
  if (admin === null || !existsSync(join(admin, MAIN_SLOT_STAMP)))
    return { slot: null, release: () => {} };
  const fd = openSync(
    join(admin, SLOT_LOCK_FILE),
    constants.O_RDONLY | constants.O_CREAT | O_SHLOCK_DARWIN,
    0o644,
  );
  const leases = join(admin, SLOT_LEASES_DIR);
  mkdirSync(leases, { recursive: true });
  const file = join(leases, `${process.pid}.g1.json`);
  writeFileSync(
    `${file}.tmp`,
    `${JSON.stringify({ pid: process.pid, kind: "guard", mode: "shared", acquiredAt: new Date().toISOString() })}\n`,
  );
  renameSync(`${file}.tmp`, file);
  let released = false;
  return {
    slot: root,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      closeSync(fd); // closing the descriptor drops the lock
    },
  };
}

/**
 * The checkout main's code is served from, read from the repo's git store
 * alone (this file cannot resolve the data root `current` lives in): the
 * stamped main slot most recently made the served one — what `current` names
 * — or, before any slot was served, the repo's own main checkout `mainRoot`.
 */
export function servedMainRoot(commonDir: string, mainRoot: string): string {
  const worktrees = join(commonDir, "worktrees");
  if (!existsSync(worktrees)) return mainRoot;
  let best: { at: number; root: string } | null = null;
  for (const name of readdirSync(worktrees)) {
    const admin = join(worktrees, name, GIT_LOCK_DIR);
    const served = join(admin, MAIN_SLOT_SERVED_FILE);
    if (!existsSync(join(admin, MAIN_SLOT_STAMP)) || !existsSync(served))
      continue;
    const at = Date.parse(readFileSync(served, "utf8").trim());
    if (Number.isNaN(at)) throw new Error(`${served} holds no instant`);
    const gitdir = readFileSync(join(worktrees, name, "gitdir"), "utf8").trim();
    if (best === null || at > best.at) best = { at, root: dirname(gitdir) };
  }
  return best?.root ?? mainRoot;
}

function describeError(err: unknown): string {
  // Its message is the whole story; a stack would only name this file.
  if (err instanceof CheckoutNotInstalledError) return err.message;
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}…`
    : text;
}

/**
 * Runs the live guard; if it throws (a module in its import closure that does
 * not load, a guard that crashes), runs main's guard instead and tells the
 * agent so on the verdict. Never fails open: no fallback, or a fallback that
 * fails too, is a failure — which the hook command turns into a block.
 */
export async function runGuardWithFallback(opts: {
  live: () => Promise<string>;
  /** `null` when there is nothing to fall back to (the live checkout is main). */
  fallback: () => Promise<Fallback | null>;
}): Promise<BootstrapResult> {
  let liveError: string;
  try {
    return { ok: true, stdout: await opts.live() };
  } catch (err) {
    liveError = describeError(err);
  }
  const fallback = await opts.fallback();
  if (fallback === null)
    return {
      ok: false,
      stderr: `guards: the PreToolUse guard threw, and this checkout is main — there is no other guard to fall back to:\n${liveError}`,
    };
  const notice =
    `guards: this checkout's PreToolUse guard (${fallback.liveRoot}) failed, so main's guards (${fallback.mainRoot}) judged this call instead. ` +
    `Fix it — a module the guard imports is probably mid-edit; every call carries this note until it loads:\n${liveError}`;
  const run = await fallback.run();
  const verdict = run.ok ? noticed(run.stdout, notice) : run;
  if (!verdict.ok)
    return {
      ok: false,
      stderr:
        `guards: this checkout's PreToolUse guard (${fallback.liveRoot}) threw:\n${liveError}\n\n` +
        `and main's guard (${fallback.mainRoot}), run in its place, failed too:\n${verdict.error}`,
    };
  return { ok: true, stdout: verdict.stdout };
}

/** {@link withNotice}, an output it cannot read being a failed run, never an allow. */
function noticed(stdout: string, notice: string): GuardRun {
  try {
    return { ok: true, stdout: withNotice(stdout, notice) };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { ok: false, error: `unreadable output: ${err.message}` };
  }
}

/**
 * `stdout` (a PreToolUse hook output, or "" for a silent allow) with `notice`
 * added where the agent reads it: a denial's reason, else the call's
 * additional context. Throws on output that is not a hook output object.
 */
export function withNotice(stdout: string, notice: string): string {
  const parsed: unknown = stdout.trim() === "" ? {} : JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`not a hook output object: ${stdout.slice(0, 200)}`);
  const out = parsed as Record<string, unknown>;
  const specific: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    ...(out.hookSpecificOutput as Record<string, unknown> | undefined),
  };
  const append = (prev: unknown) =>
    typeof prev === "string" && prev !== "" ? `${prev}\n\n${notice}` : notice;
  if (specific.permissionDecision === "deny")
    specific.permissionDecisionReason = append(
      specific.permissionDecisionReason,
    );
  else specific.additionalContext = append(specific.additionalContext);
  return JSON.stringify({ ...out, hookSpecificOutput: specific });
}

function exec(
  argv: readonly [string, ...string[]],
  opts: { cwd: string; stdin?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}

/**
 * Main's copy of `script` (an absolute path inside the live checkout), run as
 * Claude Code would run it: from main's root, the payload on stdin. Main's
 * root is the code main SERVES (`servedMainRoot`: its current slot, the
 * repo's main checkout before there is one), so the fallback runs what main
 * runs, not a tree a push rewrites. The contract between the two checkouts is
 * the hook protocol itself, so a main and a worktree at different versions
 * still agree on it. Resolved from git only here, on the failure path; `null`
 * when the live checkout is main's served one. Main's guard, run as its own
 * bootstrap, takes its own lease on its slot.
 */
export async function mainCheckoutFallback(
  script: string,
  raw: string,
): Promise<Fallback | null> {
  const git = await exec(
    [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    { cwd: dirname(script) },
  );
  if (git.code !== 0)
    throw new Error(
      `git rev-parse failed in ${dirname(script)}: ${git.stderr}`,
    );
  const [liveRoot, commonDir] = git.stdout.trim().split("\n");
  if (!liveRoot || !commonDir)
    throw new Error(`git rev-parse printed no roots: ${git.stdout}`);
  const mainRoot = servedMainRoot(commonDir, dirname(commonDir));
  if (realpathSync(mainRoot) === realpathSync(liveRoot)) return null;
  const mainScript = join(mainRoot, relative(liveRoot, script));
  return {
    liveRoot,
    mainRoot,
    async run() {
      const r = await exec(["bun", mainScript], { cwd: mainRoot, stdin: raw });
      return r.code === 0
        ? { ok: true, stdout: r.stdout }
        : { ok: false, error: `exit ${r.code}\n${r.stderr.trim()}` };
    },
  };
}
