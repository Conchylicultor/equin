// The guard's trust anchor. `./guard.ts` and this file import NOTHING from the
// repo — `node:` builtins only (`guards:bootstrap-builtins-only`) — because
// everything else they could import lives in the checkout the agent is editing.
// See "The guard survives a broken checkout" in ../CLAUDE.md.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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
 * Claude Code would run it: from main's root, the payload on stdin. The
 * contract between the two checkouts is the hook protocol itself, so a main
 * and a worktree at different versions still agree on it. Resolved from git
 * only here, on the failure path; `null` when the live checkout is main.
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
  const mainRoot = dirname(commonDir);
  if (mainRoot === liveRoot) return null;
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
