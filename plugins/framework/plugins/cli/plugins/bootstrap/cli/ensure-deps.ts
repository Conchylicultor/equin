/**
 * `ensureDeps()` — the ONE chokepoint for "this checkout's `node_modules` is
 * correct for its declared inputs".
 *
 * It replaces the `bun install --silent` that used to run in the `./equin`
 * shell wrapper, which had three defects in one line: it was **unserialized**
 * (a `check`'s install could race a `build`'s and lose — bun 1.3.13 has no
 * install mutex of its own, and concurrent installs in one checkout race on
 * `clonefileat`), **unattributed** (`--silent` + `set -e` aborted the wrapper
 * before `exec`, so a failed *precondition* became a bare exit 1 that read as
 * the subcommand failing), and **unconditional** (10–25 s of network-bound
 * resolution on every invocation, twice per build).
 * Design: `research/2026-07-30-cli-silent-exit-preinstall-ensure-deps.md`.
 *
 * Freshness is what unlocks the other two fixes: once the common case is silent,
 * there is no longer any reason for `--silent`, so the install runs with
 * stdout/stderr passed straight through and a failure can never again be
 * invisible.
 *
 * MEASURED COST of the fresh-skip path on this repo: ~140 ms — ~126 ms of it the
 * recursive walk of `plugins/` (4044 dirs, 8379 files), ~1.5 ms the 1003 stats —
 * plus ~15 ms of module import, plus one `git rev-parse` when `root` is
 * defaulted. A 60–160× win over the 10–25 s install it replaces, so the walk is
 * deliberately left correct rather than narrowed to the plugin-tree convention:
 * `workspaces: ["plugins/**"]` admits a `package.json` at any depth, and missing
 * one would silently skip a needed install.
 *
 * PRE-INSTALL-SAFE — this module runs BEFORE `node_modules` exists (the CLI
 * bootstrap awaits it; `mise`'s setup task runs it standalone), so it may import
 * only node builtins, relative modules, and `@plugins/*` aliases — never an npm
 * package, and nothing that reaches a plugin barrel with side effects. Static
 * imports hoist above every await, so ONE npm import here breaks a fresh
 * checkout at parse time. `@plugins/*` resolves from `tsconfig.base.json` with
 * no `node_modules` present, and `@plugins/infra/plugins/spawn/core` is verified
 * safe (its transitive imports are node builtins + `spawn-priority/core`). Same
 * class of constraint as the ALIAS-FREE docblock in
 * `plugins/framework/plugins/tooling/plugins/provision/scripts/run-provisions.ts`
 * — but not the same rule: that one runs in the `bun install` postinstall
 * context, where the alias does *not* resolve.
 */
import { createHash } from "node:crypto";
import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  getWorktreeRoot,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { acquireCheckoutLock } from "./checkout-lock";

/**
 * The freshness stamp, INSIDE `node_modules` on purpose: the stamp can never
 * outlive the thing it describes, so `rm -rf node_modules` always forces a real
 * install. (Already gitignored, being under `node_modules/`.)
 */
export const STAMP_REL = join("node_modules", ".equin-deps");

/**
 * Bumped when the stamp's shape or the signature's inputs change; an older
 * version reads as "no stamp", i.e. install.
 */
const STAMP_VERSION = 1;

/**
 * The install lock, a sibling of the build's `.build.lock` and deliberately NOT
 * the same file: sharing them would make a `./equin check` block for an
 * entire concurrent build. Its span is equally load-bearing — see `ensureDeps`.
 */
const INSTALL_LOCK_REL = ".install.lock";

/**
 * The provision registry, a dep input because provisions run as the root
 * `postinstall`: a plugin that adds a `provision/index.ts` without touching any
 * `package.json` would otherwise be skipped forever.
 */
const PROVISION_REGISTRY_REL = join(
  "plugins",
  "framework",
  "plugins",
  "tooling",
  "plugins",
  "provision",
  "core",
  "provision.generated.ts",
);

/** Never walked: `node_modules` is the OUTPUT, and `.git` holds no dep inputs. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * What happened to `node_modules` during the call — and, through that, whether
 * THIS process can still trust its own module resolver.
 *
 * **Every kind but `fresh` is a constraint on the CALLER, not just a report:**
 * Bun's resolver caches directory listings from process start, so a process
 * whose `node_modules` changed after it started cannot see the change — a
 * workspace-local `node_modules` cached as absent stays absent for the process's
 * whole life. A caller that goes on to import an npm package after a non-`fresh`
 * result may die with `Cannot find package …`. The bootstrap answers this by
 * re-execing (`./reexec.ts`); a caller that cannot re-exec must be satisfied that
 * everything it still needs is already resolved.
 *
 * WHO ran the install does not matter to that constraint, which is why this is
 * not a `{ installed: boolean }`. It was, and its `false` arm covered both "the
 * stamp was fresh on the first look" and "the stamp was stale, so I waited on
 * `.install.lock` while ANOTHER command installed, and the re-check under the
 * lock found it fresh". The second is exactly as stale-cached as installing
 * yourself, but read as "nothing changed": `./equin build` launched beside
 * a `./equin test` in a fresh worktree skipped its re-exec and died on
 * `commander`. With the concurrent case its own kind, no caller can read it as
 * the untouched one.
 */
export type EnsureDepsResult =
  /** The stamp matched on the first look: `node_modules` did not change during this call. */
  | { kind: "fresh" }
  /** This call ran `bun install`. */
  | { kind: "installed" }
  /**
   * The stamp was stale on the first look, and fresh by the time this call held
   * `.install.lock` — another command in this checkout installed in between
   * (almost always the lock holder this call waited on).
   */
  | { kind: "installed-by-other" };

/** The subset of a spawn result this module reads — see `EnsureDepsOptions.installer`. */
export interface InstallOutcome {
  exitCode: number;
  signalCode?: string | null;
}

export interface EnsureDepsOptions {
  /** Repo root; defaults to `getWorktreeRoot()`. */
  root?: string;
  /** Progress sink; defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * Install with `--frozen-lockfile`: resolve nothing, fail rather than rewrite
   * `bun.lock`. For the caller that has just checked out someone else's lockfile
   * and must install EXACTLY it — `push`, mid-rebase, one step before the checks
   * and the fast-forward merge, where a re-resolved lockfile would dirty the tree
   * it is about to land on main.
   */
  frozenLockfile?: boolean;
  /**
   * @internal TEST SEAM. Overrides how the install is run, so the test suite can
   * exercise the freshness gate, the under-lock re-check and the failure wording
   * without a real 10–25 s `bun install` (three agents share a checkout;
   * concurrent installs are the bug under repair). Production callers pass
   * nothing and get `runBunInstall`. Mirrors how `checkout-lock.ts` exposes its
   * timings through `opts` purely so its own test can drive them.
   *
   * Takes `frozenLockfile` as an argument rather than closing over it, so the
   * flag that decides whether a mid-push tree can be re-resolved is visible to
   * the seam instead of invisible inside a wrapper.
   */
  installer?: (
    root: string,
    frozenLockfile: boolean,
  ) => Promise<InstallOutcome>;
}

/** What `node_modules/.equin-deps` holds. */
interface DepStamp {
  version: number;
  /** sha256 over the sorted `(relPath, mtimeMs, size)` fingerprint of every dep input. */
  signature: string;
  /**
   * Compared separately from `signature` (rather than folded into it) so the
   * mismatch can name itself in the install reason. A bun upgrade must reinstall:
   * the lockfile format and `node_modules` layout are bun's, not ours.
   */
  bunVersion: string;
  /** How many inputs were fingerprinted. Diagnostics only — never compared. */
  inputs: number;
  writtenAt: string;
}

interface DepSignature {
  hash: string;
  inputs: number;
}

/**
 * A stamp read. Discriminated rather than `DepStamp | null` so "there is no
 * usable stamp" is a state the caller must branch on, and so the reason survives
 * into the install log.
 */
type StampRead =
  { kind: "stamp"; stamp: DepStamp } | { kind: "absent"; why: string };

type Freshness = { fresh: true } | { fresh: false; reason: string };

/**
 * The directories the workspace globs can reach, DERIVED from the root
 * `package.json` rather than hardcoded, so adding a workspace root (today just
 * `plugins/**`) cannot silently fall out of the dep signature. Each glob
 * contributes its leading literal segments (`plugins/**` → `plugins`); a glob
 * that wildcards its first segment yields `""`, i.e. the repo root itself, which
 * is still bounded because the walk skips `node_modules` and `.git`.
 *
 * The missing/`workspaces`-less `package.json` throw is load-bearing: it is the
 * one failure this module cannot otherwise detect. A wrong `root` would produce
 * an EMPTY input set, hence a stable signature, hence a checkout that never
 * installs again — a silent false "fresh" instead of a loud error.
 */
function workspaceWalkRoots(root: string): string[] {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    workspaces?: unknown;
  };
  if (!Array.isArray(pkg.workspaces)) {
    throw new Error(
      `${PRODUCT_NAME}: ${pkgPath} has no "workspaces" array, so ${root} is not the ` +
        `repo root — refusing to compute a dependency signature over an empty input set.`,
    );
  }
  const roots = new Set<string>();
  for (const glob of pkg.workspaces) {
    if (typeof glob !== "string") {
      throw new Error(
        `${PRODUCT_NAME}: ${pkgPath} has a non-string "workspaces" entry: ${String(glob)}`,
      );
    }
    const literal: string[] = [];
    for (const seg of glob.split("/")) {
      if (/[*?[\]{}!]/.test(seg)) break;
      literal.push(seg);
    }
    roots.add(literal.join("/"));
  }
  return [...roots];
}

/**
 * Collect the workspace-side dep inputs under `dir`: every `package.json` and
 * every `provision/index.ts`.
 *
 * A vanished directory is tolerated (`ENOENT` only): codegen and the `dist.*`
 * swap rename directories under `plugins/` while we walk, and a directory that
 * no longer exists cannot hold a live workspace. Every other fs error propagates.
 */
function collectWorkspaceInputs(
  dir: string,
  root: string,
  out: Set<string>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectWorkspaceInputs(full, root, out);
      continue;
    }
    // Plain files only — a symlinked dir (`web-core/dist`) is never a dep input,
    // and not following links is what keeps the walk cycle-free.
    if (!entry.isFile()) continue;
    const isProvisionEntry =
      entry.name === "index.ts" && basename(dir) === "provision";
    if (entry.name === "package.json" || isProvisionEntry) {
      out.add(relative(root, full));
    }
  }
}

/**
 * Fingerprint every dependency input as `(mtimeMs, size)` — the same cheap idiom
 * as `infra/corpus-index` — and hash the sorted result.
 *
 * `bun.lock` alone would not do: editing a plugin's `package.json` without
 * installing leaves `bun.lock` stale, so the `package.json` SET has to be in the
 * signature too. Paths are relative and the list is sorted because
 * `readdirSync` order is not stable across filesystems and the stamp must
 * describe the checkout, not the machine that wrote it.
 */
function computeDepSignature(root: string): DepSignature {
  const rels = new Set<string>([
    "bun.lock",
    "package.json",
    PROVISION_REGISTRY_REL,
  ]);
  for (const walkRoot of workspaceWalkRoots(root)) {
    collectWorkspaceInputs(join(root, walkRoot), root, rels);
  }
  const lines = [...rels].sort().map((rel) => {
    // `throwIfNoEntry: false` narrows the tolerated error to ENOENT; EACCES and
    // friends still throw. Absent is a legitimate INPUT STATE (no provision
    // registry yet, no `bun.lock` in a hand-made checkout), recorded as its own
    // marker so both appearing and disappearing move the signature.
    const st = statSync(join(root, rel), { throwIfNoEntry: false });
    return st ? `${rel}\t${st.mtimeMs}\t${st.size}` : `${rel}\t-`;
  });
  return {
    hash: createHash("sha256").update(lines.join("\n")).digest("hex"),
    inputs: lines.length,
  };
}

function isDepStamp(value: unknown): value is DepStamp {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    typeof v.signature === "string" &&
    typeof v.bunVersion === "string" &&
    typeof v.inputs === "number"
  );
}

function readStamp(stampPath: string): StampRead {
  let raw: string;
  try {
    raw = readFileSync(stampPath, "utf8");
  } catch (err) {
    // ENOENT covers both "no stamp" and "no `node_modules` at all".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", why: "no dependency stamp" };
    }
    throw err; // EACCES / EISDIR / … is a real problem, never swallowed
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // NOT error-swallowing: a stamp we cannot parse makes no claim about
    // `node_modules`, so the only sound reading is "there is no stamp", whose
    // consequence is a full install — the loud, safe direction, never a false
    // "fresh". The parse error itself is carried into the install reason so a
    // corrupt stamp is visible rather than merely tolerated.
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "absent", why: `unparseable dependency stamp (${detail})` };
  }
  if (!isDepStamp(parsed)) {
    return { kind: "absent", why: "dependency stamp has an unexpected shape" };
  }
  if (parsed.version !== STAMP_VERSION) {
    return {
      kind: "absent",
      why: `dependency stamp is v${parsed.version}, expected v${STAMP_VERSION}`,
    };
  }
  return { kind: "stamp", stamp: parsed };
}

function freshness(read: StampRead, signature: DepSignature): Freshness {
  if (read.kind === "absent") return { fresh: false, reason: read.why };
  if (read.stamp.bunVersion !== Bun.version) {
    return {
      fresh: false,
      reason: `bun ${read.stamp.bunVersion} → ${Bun.version}`,
    };
  }
  if (read.stamp.signature !== signature.hash) {
    return { fresh: false, reason: "dependency inputs changed" };
  }
  return { fresh: true };
}

/** Write the stamp atomically, so a concurrent reader never sees a half-written one. */
function writeStamp(stampPath: string, signature: DepSignature): void {
  const stamp: DepStamp = {
    version: STAMP_VERSION,
    signature: signature.hash,
    bunVersion: Bun.version,
    inputs: signature.inputs,
    writtenAt: new Date().toISOString(),
  };
  // A real `bun install` has already created `node_modules`; the mkdir matters
  // only for an injected installer that does not.
  mkdirSync(dirname(stampPath), { recursive: true });
  const temp = `${stampPath}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(temp, stampPath);
}

/**
 * The real install. NO `--silent`: the freshness gate means this only runs when
 * the dep inputs actually changed, so its output is signal rather than
 * per-invocation noise — and passthrough is the whole reason a failed install can
 * no longer be invisible.
 */
function runBunInstall(
  root: string,
  frozenLockfile: boolean,
): Promise<InstallOutcome> {
  const argv = frozenLockfile
    ? ["bun", "install", "--frozen-lockfile"]
    : ["bun", "install"];
  return spawnPassthrough(argv, { cwd: root });
}

/**
 * Name the PHASE unambiguously. The historical bug was attribution: an install
 * failure that read as the subcommand's own failure sent two agents hunting for
 * a check failure that did not exist.
 */
function installFailureMessage(result: InstallOutcome): string {
  const how = result.signalCode
    ? `killed by ${result.signalCode}`
    : `exited ${result.exitCode}`;
  return (
    `${PRODUCT_NAME}: dependency install FAILED — \`bun install\` ${how}.\n` +
    `  This is the DEPENDENCY INSTALL phase, not the command you asked for: ` +
    `that command never ran, and its own result is unknown.\n` +
    `  bun install's output is above — it runs with stdout/stderr passed ` +
    `through, so nothing was captured here. If there is nothing above, bun ` +
    `install printed nothing, and that silence is itself the evidence.\n` +
    `  Likely cause: another \`bun install\` is running in this checkout ` +
    `outside the CLI (bun 1.3.13 has no install mutex; concurrent installs race ` +
    `on clonefileat). Retry, or wait for the other install to finish.`
  );
}

/**
 * Ensure `node_modules` matches this checkout's dependency inputs, installing at
 * most once and never concurrently with another CLI-mediated install.
 *
 * Throws — never returns a soft result — when the install itself fails: the
 * caller's command must not run against a `node_modules` we know is wrong.
 */
export async function ensureDeps(
  opts: EnsureDepsOptions = {},
): Promise<EnsureDepsResult> {
  const root = opts.root ?? (await getWorktreeRoot());
  const log = opts.log ?? ((line: string) => console.log(line));
  const install = opts.installer ?? runBunInstall;
  const stampPath = join(root, STAMP_REL);

  // Fast path: no lock, no subprocess, no output.
  if (freshness(readStamp(stampPath), computeDepSignature(root)).fresh) {
    return { kind: "fresh" };
  }

  // The lock spans EXACTLY the install + stamp write, and is released before we
  // return — unlike `app-artifacts.ts:acquireArtifactLock`, which drops the
  // closure and holds `.build.lock` for its whole process. Holding this one that
  // long would reintroduce the very pathology `.install.lock` exists to avoid,
  // by another route: agent A edits a `package.json` and runs a 3-minute
  // `./equin build`; agent B's `./equin check` sees the same stale
  // inputs and would block on A's ENTIRE BUILD rather than on A's install — and
  // since `acquireCheckoutLock`'s cap is 10–30 min, a long enough holder converts a
  // waiter's wait into a thrown timeout.
  //
  // Residual hazard, accepted and stated rather than silently traded away: a
  // dep-input edit DURING a build lets a second CLI process relink
  // `node_modules` underneath the first. Holding the lock longer would only
  // partially cover it anyway — the relink source that actually occurs in
  // practice is a human typing bare `bun install`, which takes no lock at all.
  //
  // Lock order is one-way: `.build.lock` → `.install.lock`, never the reverse.
  const release = await acquireCheckoutLock(resolve(root, INSTALL_LOCK_REL), {
    what: "dependency install",
  });
  try {
    // Re-check UNDER the lock: if we waited at all, the holder we waited on has
    // very likely just done this exact install. NOT `fresh` though — the stamp
    // was stale on this process's first look, so `node_modules` changed under it
    // (see `EnsureDepsResult`).
    const state = freshness(readStamp(stampPath), computeDepSignature(root));
    if (state.fresh) return { kind: "installed-by-other" };

    log(`Installing dependencies — ${state.reason}...`);
    const result = await install(root, opts.frozenLockfile === true);
    if (result.exitCode !== 0) throw new Error(installFailureMessage(result));

    // Recompute AFTER the install: it rewrites `bun.lock`, and its postinstall
    // provisions can rewrite the provision registry.
    writeStamp(stampPath, computeDepSignature(root));
    return { kind: "installed" };
  } finally {
    release();
  }
}

if (import.meta.main) {
  await ensureDeps().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
