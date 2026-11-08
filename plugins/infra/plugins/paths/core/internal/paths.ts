import { homedir } from "node:os";
import {
  readEnv,
  readEnvPath,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { basename, join, resolve } from "node:path";
import {
  asNamespace,
  MAIN_COMPOSITION_ID,
  NAMESPACE_LABEL_RE,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
// The RUNTIME's own namespace — a different question from every path below,
// which is why it moved out of this file. `runtime-identity` is a leaf (its only
// import is `namespace/core`, which this module already reaches), so the edge
// costs no closure anywhere.
import {
  isMain,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import {
  LEGACY_IDS,
  PRODUCT_NAME,
} from "@plugins/framework/plugins/product-name/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  readHomeDataRootLayoutSync,
  type DataRootLayout,
} from "./data-root-layout";

export const PLUGINS_DIR = joinAppPath(REPO_ROOT, "plugins");

/**
 * The git-layer config tree (`config/<hier>/<name>.origin.jsonc`, overrides, and
 * `@app/<id>` scopes). Read directly at runtime by config_v2's raw-diff panel and
 * per-app un-fork check. In a release `REPO_ROOT` resolves into the compiled
 * binary's virtual FS (un-shipped, unreachable), so `launch.ts` points this at the
 * vendored tree via `EQUIN_REPO_CONFIG_DIR`; in dev it falls back to the repo.
 *
 * A FUNCTION for the same reason as {@link resolveDataRootSync} and
 * {@link worktreesDir}: `launch.ts` sets its env var, and a const would capture
 * whatever the environment said when this module was first imported. With this
 * one converted, NO constant in this module freezes an environment read — which
 * is what retires `launch.ts`'s "do not statically import anything
 * path-dependent" ordering discipline.
 */
export function repoConfigDir(): AppPath {
  return readEnvPath("REPO_CONFIG_DIR") ?? joinAppPath(REPO_ROOT, "config");
}

// The web-core plugin dir, relative to a checkout root. Used for the
// per-checkout `.build.lock` beside it and (until S5) the legacy served-dist
// reap. It is NOT where a built frontend lives any more — see `webDistDir()`.
export const WEB_CORE_RELATIVE = "plugins/framework/plugins/web-core";

/**
 * The server-core plugin dir, relative to a checkout root — the `server` field
 * of every `spec.json` a checkout publishes, and therefore the on-disk
 * back-pointer from a live namespace to the checkout that deployed it.
 *
 * Spelled ONCE because it is read from both ends and by different processes:
 * `deployNamespace` resolves it against the checkout it is building, and
 * `deploysForCheckoutSync` matches every registered spec against it to answer which
 * deploys a checkout owns. A second copy that drifted would not fail anywhere —
 * it would answer "this checkout has published nothing", which reads as "you
 * never built" and sends the reader after the wrong fix.
 */
export const SERVER_CORE_RELATIVE = "plugins/framework/plugins/server-core";

/**
 * The serving entry of a composition's backend, relative to the server-core dir
 * (the spec's `server`, the backend's cwd): the file the spec's `command` runs.
 *
 * The main composition's is the committed `bin/index.ts` — also the gateway's
 * fallback when a spec has no `command`. Any other composition's is the
 * gitignored `bin/index.composition.<id>.generated.ts` its build writes beside
 * its filtered registries (codegen's `generateCompositionRegistry`). Each entry
 * imports its registries by a LITERAL path, so the code a backend runs is a
 * closure `sourceDigest` can follow; which app a backend is gets decided by
 * which entry its spec runs, and checked against the spec's `composition` at
 * boot (server-core `bin/serve.ts`).
 */
export function backendEntryFor(composition: string): string {
  if (composition === MAIN_COMPOSITION_ID) return "bin/index.ts";
  // One namespace label: it becomes a filename segment.
  if (!NAMESPACE_LABEL_RE.test(composition)) {
    throw new Error(`Invalid composition id "${composition}".`);
  }
  return `bin/index.composition.${composition}.generated.ts`;
}

/**
 * True when this backend is running inside a compiled release artifact (the
 * `launch` binary sets `EQUIN_RELEASE=1` before bringing up the app; it
 * travels launch → gateway → backend as a forwarded name of the declared runtime
 * environment, `launcher/core`). A release runs exactly ONE backend
 * per host, so this is the release-side twin of `isMain()` for host-singleton
 * work (e.g. the cluster sentinel + duress latch): in a release the backend's
 * runtime namespace is the composition name, so `isMain()` is false, yet that
 * single backend IS the host singleton.
 */
export function isRelease(): boolean {
  return readEnv("RELEASE") === "1";
}

/**
 * True when THIS backend is the one that owns host-wide singleton work — the
 * host-global caches/archives, the cluster-wide samplers, the once-per-host
 * scheduled sweeps. Gate such work on this, never on `isMain()` alone.
 *
 * In dev the fleet is many worktree backends and main is that singleton. In a
 * compiled release there is exactly ONE backend per host, but it runs under the
 * composition name, so `isMain()` is false — gating on `isMain()` means the work
 * silently never runs in a release, which is invisible precisely because there
 * is no second backend to notice the gap.
 */
export function isHostSingleton(): boolean {
  return isMain() || isRelease();
}

/** WHICH build is running. Both fields are null outside a release. */
export interface ReleaseIdentity {
  /** The release run that produced this bundle (`RELEASE.json.runId`). */
  runId: string | null;
  /** The composition this bundle is (`RELEASE.json.composition`). */
  composition: string | null;
}

// Where the identity rides: the same launch → gateway → backend env chain
// `isRelease()` uses. Both names are forwarded names of the declared runtime
// environment (`RUNTIME_FORWARDED_ENV` in `launcher/env-names`): the launcher spawns
// the gateway with that subset of its live `process.env`, and the gateway hands
// the same subset to the backend — so a name missing from that list would
// silently never arrive. Private to this module on purpose —
// `setReleaseIdentity` / `releaseIdentity` are the only surface, so the names
// exist once and no consumer can spell one of them wrong.

/**
 * Read which build is serving. This is a *propagation* of `RELEASE.json`, not a
 * second authority: the launcher stamps it verbatim from the manifest it already
 * parses, so a consumer reading it (the health payload, so a deploy can prove
 * the build it shipped is the build now answering) cannot be told a different
 * story than the bundle's own record.
 */
export function releaseIdentity(): ReleaseIdentity {
  return {
    runId: readEnv("RELEASE_RUN_ID") ?? null,
    composition: readEnv("RELEASE_COMPOSITION") ?? null,
  };
}

/**
 * Stamp the release identity into the environment, for inheritance by every
 * process spawned after this call. Called by the launcher from the manifest,
 * BEFORE the gateway spawn — a child's env is snapshotted at spawn, so a later
 * write would never reach the backend.
 */
export function setReleaseIdentity(identity: ReleaseIdentity): void {
  for (const [key, value] of [
    ["RELEASE_RUN_ID", identity.runId],
    ["RELEASE_COMPOSITION", identity.composition],
  ] as const) {
    // A null field deletes rather than writes "null" / "": an absent var is how
    // "not a release" is spelled, and a stale inherited value must not survive.
    if (value === null) unsetEnv(key);
    else setEnv(key, value);
  }
}

/**
 * The worktree name a CHECKOUT ON DISK carries: its root directory's basename.
 * This is the identity a **CLI process** has, and the one every per-worktree
 * artifact a CLI produces is keyed by (the op marker, the build profile, the
 * build-progress log, the DB fork name — and, since the release dist moved out
 * of the checkout, `worktreeArtifacts.releaseWebDist`).
 *
 * DELIBERATELY NOT `runtimeNamespace()`
 * (`@plugins/infra/plugins/runtime-identity/core`), and the two are not
 * interchangeable:
 *
 * - `runtimeNamespace()` is the namespace a RUNTIME serves — declared at its
 *   entry point from the `--namespace` the gateway spawned it with. It is the
 *   right answer THERE: a composition namespace's backend runs out of main's
 *   checkout, so only its spawner can say which namespace it serves.
 * - A CLI process declares no runtime namespace at all, so asking for one
 *   throws. Anything a CLI writes per-worktree derives its name from the
 *   checkout it is operating on.
 *
 * Two processes that must agree on which checkout produced an artifact — a
 * `release` and the `build --hermetic` child it spawns with `cwd` at that same
 * root — both call this on that root, so they cannot drift.
 *
 * Returns a plain `string`, NOT a {@link Namespace}, and that is the point. A
 * checkout name is one INPUT to a namespace, not a namespace: they are equal for
 * every agent worktree today and stop being equal the moment a composition is
 * served from a non-main checkout. Casting across that gap —
 * `asNamespace(checkoutWorktreeName(root))` — is how an e2e run came to drive
 * MAIN's app from a worktree and report ALL CHECKS PASSED, so that expression
 * is now rejected outright by
 * `namespace-identity/no-laundered-checkout-namespace`.
 *
 * Ask whichever of the two questions you actually have instead:
 *
 * - which namespace does this checkout OWN? — `checkoutNamespace(root)`, which
 *   mints it from git (`namespaceFor` over `checkoutRef`) rather than from a
 *   basename, and answers whether or not anything was ever deployed;
 * - which deploy did this checkout PUBLISH? — `resolveCheckoutDeploySync(root)`,
 *   read back out of the `spec.json` that build wrote. It is the only one that
 *   can answer "nothing yet", and the only one that can name a composition
 *   deploy (`sonata.att-x`), whose namespace shares no label with this string.
 */
export function checkoutWorktreeName(root: string): string {
  return basename(root);
}

/**
 * The user's home, in the one spelling every path read derives from: resolved
 * (no trailing slash, `.`/`..` collapsed), so a non-canonical `$HOME`
 * (`HOME=/Users/x/`) cannot make the home a browser shortens `~/…` against
 * disagree with the paths host-fs returns (each one `resolve()`d).
 */
export const HOME_DIR = resolve(homedir());

/**
 * The data root, derived AT CALL TIME.
 *
 * THE single derivation of the root, and the ONLY read of `EQUIN_DIR` in
 * this plugin. Not exported from the barrel on purpose: `dataRoot()`
 * (`./data-dir.ts`) is its public spelling, so a consumer that wants the root
 * gets the lazy function, and a consumer that wants a directory under it gets a
 * `DataDir`.
 *
 * There is deliberately no eager `EQUIN_DIR` const beside this any more.
 * A frozen snapshot of the root was both the second spelling that let the
 * registry be bypassed by hand (`join(EQUIN_DIR, "whatever")` minted an
 * undeclared top-level entry that nothing failed on) and a value captured at
 * whatever the environment said when this module was FIRST imported — while the
 * release launcher sets `EQUIN_DIR` before importing anything
 * path-dependent. `paths:data-root-not-joined` now fails on either way back.
 *
 * A function for that second reason, the same one that makes `webDistDir()` a
 * function and `DataDir.path` a getter. See `webDistDir`'s docblock below.
 */
export function resolveDataRootSync(): AppPath {
  return dataRootLayoutSync().root;
}

/**
 * Where the root is, and why: named by the environment (`custom`), an install
 * not yet migrated (`legacy`, `LEGACY_IDS.dataDirName`), or the current
 * `~/.equin` (`data-root-layout.ts`).
 *
 * The home-relative half reads the disk, so it is decided once per process:
 * an install changes layout only through `./equin data-dir migrate`, which
 * runs with every other process of the app stopped and starts the gateway it
 * restores as a fresh process. The environment is still read on every call,
 * for the reason in {@link resolveDataRootSync}.
 */
export function dataRootLayoutSync(): DataRootLayout {
  const dir = readEnvPath("DIR");
  if (dir !== undefined) return { kind: "custom", root: dir };
  homeLayout ??= readHomeDataRootLayoutSync(HOME_DIR);
  return homeLayout;
}
let homeLayout: DataRootLayout | undefined;

/**
 * The local backups' dir — OUTSIDE the data root on purpose (`~/.backups/…`),
 * which is why it is spelled here rather than declared with `defineDataDir`: a
 * backup that lived inside the tree it backs up would be reclaimed by the same
 * sweep.
 *
 * It follows the root's layout: an install not yet migrated keeps
 * `~/.backups/<LEGACY_IDS.backupsDirName>` (the migration moves it with the root), every other
 * install uses `~/.backups/equin`. A function for the same reason as
 * {@link dataRootLayoutSync}.
 */
export function backupsDirSync(): AppPath {
  const dirs = backupsDirs();
  return dataRootLayoutSync().kind === "legacy" ? dirs.legacy : dirs.current;
}

/** Both home-relative backups dirs, current first. */
export function backupsDirs(): { current: AppPath; legacy: AppPath } {
  return {
    current: asAppPath(join(HOME_DIR, ".backups", PRODUCT_NAME)),
    legacy: asAppPath(join(HOME_DIR, ".backups", LEGACY_IDS.backupsDirName)),
  };
}

// Everything else under the data root is a DECLARATION, not a constant here.
// This module used to carry a second spelling of nine of those directories
// (`SECRETS_DIR`, `ATTACHMENTS_DIR`, `PROTOTYPES_DIR`, …) as plain
// `join(EQUIN_DIR, …)` consts. Two spellings of one directory is how the
// registry gets quietly bypassed: the declaration moves and the const does not,
// so half the code writes to the new home and half goes on writing to the old
// one, with nothing to fail. Reach a directory through its owner's
// `data-dirs/index.ts` declaration — never by joining the root again.

/**
 * Root dir holding every worktree's per-worktree state. Each
 * worktree owns `<worktreesDir()>/<name>/` (build/release artifacts, logs, ops
 * markers, …). THE single source of truth for the
 * `worktrees/<name>` layout — server plugins and the CLI both derive from it so
 * the base path can never diverge.
 *
 * `worktrees` is one of the eight `DATA_DIR_KINDS`, and this is the kind
 * directory itself rather than an entry under one, which is why it is spelled
 * here rather than declared with `defineDataDir`: its children are namespaces
 * minted at runtime, not a fixed set anyone could declare.
 *
 * A FUNCTION, not a const, for the reason in {@link resolveDataRootSync} — a const
 * would freeze the root at whatever the environment said when this module was
 * first imported, which is precisely the bug the eager `EQUIN_DIR` used
 * to carry.
 */
export function worktreesDir(): AppPath {
  return joinAppPath(resolveDataRootSync(), "worktrees");
}

/** The per-worktree data dir: `<worktreesDir()>/<name>/`. */
export function worktreeDataDir(name: Namespace): AppPath {
  return joinAppPath(worktreesDir(), name);
}

/**
 * The per-worktree supervised-run artifact dir: `<worktreeDataDir()>/runs/`.
 *
 * A SUBDIRECTORY, where every other artifact family here is a flat file beside
 * its siblings, and the reason is that this family has a *watcher* on it. The
 * supervised-run supervisor publishes a live run's output by tailing its
 * transcript, and it learns the file grew from one `@parcel/watcher`
 * subscription over the directory the transcripts live in. Pointed at the data
 * dir itself that subscription would also wake on every build profile, build
 * log, check transcript and spec write in the worktree — so the directory is
 * what keeps the watch narrow, not a filter the watcher would have to remember.
 *
 * A second, smaller reason: the prune is directory-scoped
 * (`pruneRunArtifactsInDirSync`), so keeping the newest N runs cannot even in
 * principle see a `build-<id>.log` — the two families never share a directory.
 *
 * Spelled as a function above `worktreeArtifacts` because the object literal
 * cannot reference its own entries while it is being constructed; the public
 * spelling is `worktreeArtifacts.runsDir`.
 */
function runsDirFor(name: Namespace): AppPath {
  return joinAppPath(worktreeDataDir(name), "runs");
}

/**
 * The two filename suffixes of the supervised-run family.
 *
 * Exported, unlike every other suffix in this file, because this family has a
 * READER that goes the other way: the supervisor watches the directory and has
 * to turn each event's filename back into a (kind, run) pair. Without these it
 * would spell `".exit-code"` itself — a second copy of the layout, in the one
 * place a drift would silently stop every run from ever being closed. The prune
 * (`prune-artifacts.ts`) reads them for the same reason.
 */
export const RUN_TRANSCRIPT_SUFFIX = ".log";
export const RUN_TERMINAL_SUFFIX = ".exit-code";

/**
 * The gateway's registration record for a namespace: `spec.json`, inside that
 * namespace's own data dir.
 *
 * THREE processes share this one file, which is why the name has to have one
 * owner. `writeWorktreeSpec` (`infra/worktree/server/internal/spec.ts`)
 * publishes it — atomically, via a temp file it renames from, beside it. The Go
 * gateway watches `worktrees/*` for it and spawns a backend from what it says.
 * That backend then reads the SAME bytes back at boot to learn which
 * composition it serves (`server-core/bin/spec-composition.ts`), rather than
 * being told over a hop a stale gateway binary could drop.
 *
 * Exported as the bare filename as well as through `worktreeArtifacts.spec`
 * below, because the boot reader is HANDED its worktrees dir (so it stays a
 * pure function of (dir, namespace) with a tmpdir test) and therefore cannot
 * resolve this process's own root. It joins the name itself; the name is still
 * written down once.
 *
 * The gateway spells it a fourth time in Go, which cannot import this and is
 * out of the `paths:no-inlined-worktree-artifacts` check's reach.
 */
export const WORKTREE_SPEC_FILE = "spec.json";

/**
 * Canonical on-disk paths for the per-worktree files: the namespace's
 * registration record and its build/release artifacts.
 *
 * THE single source of truth for these filenames: every reader (the profiling /
 * build / release server plugins, and the backend reading back its own spec)
 * and writer (the build/release CLI plus the server-side orphan-recovery
 * fallback) derives its path from here, so a layout change is one edit and
 * readers can never drift from writers.
 *
 * Most entries are FILES, and for those the `id`-less variant is the "most
 * recent / manual CLI" artifact while passing a build/release run id yields the
 * per-run artifact for that run.
 *
 * Three entries are DIRECTORIES rather than files. `runsDir` is the plain one:
 * it is where the supervised-run family lives, and it has a directory of its
 * own so a watcher can be pointed at it (see {@link runsDirFor}); its contents
 * are ordinary id-keyed files with an ordinary prune.
 *
 * `webDist` and `releaseWebDist` are the odd ones: DIRECTORIES with no run-id
 * variant. Each is a symlink published atomically by
 * `dist-publish.ts` at `<base>` → `<base>.live.<pid>` (with `<base>.staging.*` /
 * `<base>.swap.*` siblings in flight), so the path named here is the stable
 * pointer, never the tree itself. Their cleanup is NOT the file-retention
 * pruner (`pruneWorktreeBuildArtifactsSync`, which only ever matches the file
 * patterns above): a dist tree is reclaimed by `sweepDistLeftovers` at publish
 * time and, wholesale, by `removeWorktreeSpec`'s recursive remove of
 * `worktreeDataDir(name)` (`infra/worktree/server/internal/spec.ts`).
 */
export const worktreeArtifacts = {
  /**
   * The namespace's registration record — see {@link WORKTREE_SPEC_FILE} for
   * who writes it and who reads it back. Not a build artifact (neither is
   * `buildStatus`), and it has no `<id>` variant: a namespace has exactly one
   * spec, and the file's whole job is to be found at a fixed, watched path.
   */
  spec: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), WORKTREE_SPEC_FILE),
  /**
   * The SPA shell's server-rendered `<head>` fragments, per app path:
   * `document-head.json`, `{ v: 1, entries: { "<basePath>" | "": html } }`.
   * Written by the backend (`shell/document-head`'s machine half, atomically,
   * whenever a source's answer changes); read by the Go gateway on every shell
   * request, which splices the longest-matching entry into `index.html` — so a
   * cold backend never delays the page. Like `spec`, the gateway spells the
   * name again in Go. No `<id>` variant: one live answer per namespace.
   */
  documentHead: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "document-head.json"),
  /**
   * The Bun the gateway starts this namespace's backend with, cloned under
   * the process's name (`bin/equin · server · <name>`, packages/process-name) —
   * the spec's `command` points here, so the link lives and goes with it.
   */
  processNames: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "bin"),
  /** Build profiler spans. `build-profile.json` or `build-profile-<id>.json`. */
  buildProfile: (name: Namespace, buildId?: string): AppPath =>
    joinAppPath(
      worktreeDataDir(name),
      buildId ? `build-profile-${buildId}.json` : "build-profile.json",
    ),
  /**
   * The deploy receipt: this worktree's LAST build, whatever became of it.
   *
   * Deliberately the one artifact here with NO `<id>` variant. Every sibling is
   * per-run, so "did my build land?" can only be asked of them through a glob
   * (`ls -t build-*.log | head -1`) — and that answers with a *previous* run's
   * `BUILD OK` whenever the current one was killed before writing its own. A
   * fixed path cannot do that: a killed build leaves this file at
   * `status: "running"` with a dead pid, and there is no older success for it to
   * be confused with. Do not add a `buildId` parameter.
   */
  buildStatus: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "build-status.json"),
  /**
   * One `./equin test` run's record: which runners ran and which test
   * cases failed. `test-status-<opId>.json`, written when the run STARTS
   * (`status: "running"`) and again with its verdict.
   *
   * Id-keyed, unlike `buildStatus`: two test runs in one checkout may be live
   * at once (different paths, or one joined onto another's in-flight run), and
   * a fixed path made them overwrite each other's verdict. The run's `opId` is
   * what `await` and a joiner already hold, so the record is addressable by it.
   * Pruned to the newest {@link TEST_ARTIFACTS_RETENTION} by the test command.
   */
  testStatus: (name: Namespace, opId: string): AppPath =>
    joinAppPath(worktreeDataDir(name), `test-status-${opId}.json`),
  /**
   * What one push's land phase reports back to the push that spawned it — the
   * steps it ran and its outcome. `push-land-<pushId>.json`, written by the land
   * phase as each step ends, read and deleted by the push once the phase exits
   * (cli/push handoff.ts).
   */
  pushLand: (name: Namespace, pushId: string): AppPath =>
    joinAppPath(worktreeDataDir(name), `push-land-${pushId}.json`),
  /** One runner's JUnit report for one test run. `test-<opId>-<runner>.xml`. */
  testReport: (name: Namespace, opId: string, runner: string): AppPath =>
    joinAppPath(worktreeDataDir(name), `test-${opId}-${runner}.xml`),
  /**
   * This checkout's LAST `./equin deps upgrade <updater>` — one updater named (or its alias
   * `toolchain upgrade`, for `mise`): what it moved, the failures before and
   * after, and the verdict. One fixed path per updater, written at start, like
   * `buildStatus`.
   */
  depsUpgrade: (name: Namespace, updaterId: string): AppPath =>
    joinAppPath(worktreeDataDir(name), `deps-upgrade-${updaterId}.json`),
  /**
   * This checkout's LAST `./equin deps upgrade` with no updater named —
   * every updater moved together, behind one baseline and one candidate run.
   */
  depsUpgradeBatch: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "deps-upgrade.json"),
  /**
   * One check run's full, untruncated transcript. ALWAYS id-keyed (like
   * `runTranscript`, unlike `buildStatus` directly above), and for a reason that
   * is the mirror image of the receipt's.
   *
   * A transcript is only COMPLETE once its run ends. Under a fixed path, a run
   * killed mid-checks therefore writes nothing and silently leaves its
   * predecessor's file in place — so the killed run's own verdict points a
   * reader at another run's failures. The receipt escapes that trap from the
   * other side: it is written EARLY and is meaningful while incomplete, so it
   * never needs an id. A transcript cannot be, so it buys the same guarantee
   * with identity instead. Do not converge the two.
   *
   * `runId` is the caller's OWN id — a build's `buildId`, a standalone check's
   * `opId` — never a fresh one: reusing it is what joins this file to the
   * `build-<id>.log` beside it and to the run's lines in `check-progress.jsonl`.
   */
  checkLog: (name: Namespace, runId: string): AppPath =>
    joinAppPath(worktreeDataDir(name), `check-${runId}.log`),
  /**
   * DIRECTORY. The single-flight lock, leader and verdict files of this
   * checkout's coalescable direct ops (`check`, `test` — `withDirectOp`'s
   * `flight` option): N identical requests in flight at once cost one run.
   * A directory of its own so the files (`<sha256(key)>.lock` /
   * `.leader.json` / `.verdict.json`) can never collide with an id-keyed
   * artifact family's prune. Bounded by the set of distinct keys; reclaimed
   * with the worktree's data dir.
   */
  opFlights: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "op-flights"),
  /**
   * DIRECTORY. Every supervised run's transcript and exit marker, for every
   * kind. See {@link runsDirFor} for why this family gets a directory of its own.
   */
  runsDir: (name: Namespace): AppPath => runsDirFor(name),
  /**
   * One supervised run's merged stdout+stderr transcript.
   *
   * This file IS the stream: the child writes into it through a plain kernel fd
   * and the supervisor publishes to the run's log channel by tailing it, so
   * there is no second, pipe-shaped path that only works while the process that
   * spawned the child is alive. `<kindId>-<runId>.log` — `kindId` first so a
   * kind's runs sort together and its prune can name its own family by prefix.
   */
  runTranscript: (name: Namespace, kindId: string, runId: string): AppPath =>
    joinAppPath(runsDirFor(name), `${kindId}-${runId}${RUN_TRANSCRIPT_SUFFIX}`),
  /**
   * One supervised run's exit marker: the child's status, and nothing else.
   *
   * Written by the POSIX shim the supervisor wraps every argv in, atomically
   * (tmp + rename) at the one instant the status is known — so recording it is
   * not something a command can forget to do, and its ABSENCE is the honest
   * signal that the child was hard-killed and ran no shell at all.
   *
   * The finish INSTANT is this file's mtime, which is why it holds only the
   * code: a timestamp the shell had to format would be a second thing to get
   * right, in `sh`, for no gain.
   */
  runTerminal: (name: Namespace, kindId: string, runId: string): AppPath =>
    joinAppPath(runsDirFor(name), `${kindId}-${runId}${RUN_TERMINAL_SUFFIX}`),
  /**
   * DIRECTORY. The web dist SERVED for namespace `name` — the tree the gateway
   * points at for `<name>.localhost:9000`. `name` is a *namespace*: a worktree
   * slug (the main namespace, an agent branch) or an auto-served composition id.
   */
  webDist: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "web"),
  /**
   * DIRECTORY. A release's scratch web dist — copied into the shippable bundle
   * and served by nobody. Keyed by the worktree that BUILT it (not a namespace:
   * a release has none), so two checkouts releasing the same composition, or one
   * checkout releasing two, can never share a tree.
   *
   * The `asNamespace` below is not a namespace claim — it is the data dir's own
   * grammar. Every subdirectory of `worktrees/` obeys it, checkout name or not.
   */
  releaseWebDist: (worktree: string, composition: string): AppPath =>
    joinAppPath(
      worktreeDataDir(asNamespace(worktree)),
      "release-web",
      composition,
    ),
  /**
   * What this namespace's checkout DECLARES under the data root — the
   * `${kind}/${name}` keys of its `defineDataDir` registry, plus the top-level
   * entries its `legacyLocation` declarations claim.
   *
   * Not a build artifact (neither is `spec`), and deliberately WITHOUT a run-id
   * variant: a namespace has exactly one declared set, and this file's whole job
   * is to be found at a fixed path by an audit running in a DIFFERENT checkout.
   *
   * That cross-checkout read is the point. `~/.equin/` is host-global —
   * every namespace on this box writes into it — while a checkout's declarations
   * are one branch's view, so `paths:no-undeclared-data-dirs` used to report a
   * directory another live worktree had just declared as an orphan. Each
   * namespace publishing its own set is what makes the rule as host-global as
   * the root it polices.
   *
   * The set must come from the EVALUATED registry, never from parsing the
   * `data-dirs/index.ts` sources: `infra/host/host-admission` derives one
   * `locks/<id>` declaration per entry of `HOST_POOLS`, so a declared name
   * is not always a literal anyone can grep for.
   *
   * Its lifetime is exactly right by construction — `removeWorktreeSpec` already
   * removes `worktreeDataDir(name)` recursively, so the manifest dies with the
   * namespace, i.e. at the moment that namespace stops being able to write to
   * the root.
   */
  dataDirs: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "data-dirs.json"),
  /**
   * Which checkout's CLI last acted as this namespace — `{ root }`, rewritten
   * by every op that mints the namespace from a checkout (`stampCheckoutOwnerSync`).
   * The provenance the reaper needs for a namespace that no attempt row and no
   * composition marker owns: a second clone's main checkout, an e2e's temp
   * repo, a hand-made worktree.
   */
  checkoutOwner: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "checkout.json"),
  /**
   * Which backend minted this agent checkout — `{ minter }`, the namespace whose
   * database holds its attempt row. Written by `setupWorktree` (infra/worktree) once
   * the checkout exists (`stampCheckoutMinterSync`); read by the reaper, for a
   * checkout main's attempts table does not name.
   */
  checkoutMinter: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "minted-by.json"),
  /**
   * The reaper's proof that this checkout is still dirty: the first dirty path
   * `git status` named, with that path's, the index's and HEAD's state then.
   * While all three read the same, the tree cannot have become clean, so the
   * hourly sweep skips re-walking it. Owned by debug/worktree-cleanup.
   */
  hygieneWitness: (name: Namespace): AppPath =>
    joinAppPath(worktreeDataDir(name), "hygiene-witness.json"),
} as const;

/**
 * The built frontend THIS BACKEND is serving — the tree the gateway hands the
 * browser for this backend's namespace. The one source of truth for the runtime
 * readers of the served bundle: the stale-tab signal (`.build-graph`, the
 * bundle's content identity — also what tags a report's originating tab), the
 * "N commits behind main" base (`.build-commit`) and the producing run
 * (`.build-id`).
 *
 * A FUNCTION, not a const, for two independent reasons — do not re-freeze it at
 * module eval:
 *
 * - `EQUIN_WEB_DIST` is set by the release launcher (`launch.ts`) before
 *   it imports anything path-dependent, but a const here would still capture
 *   whatever the env said when *this* module was first imported. In a release
 *   the alternative — deriving from `REPO_ROOT` — resolves into the compiled
 *   binary's virtual FS, which is why a release used to report a null build id.
 * - The derived arm is per-NAMESPACE (`runtimeNamespace()`, i.e. the
 *   `--namespace` the gateway spawned this backend with), and an
 *   auto-served composition's backend runs out of MAIN's checkout. A
 *   `REPO_ROOT`-derived path made every such backend read main's dist and
 *   report main's build id and build commit.
 *
 * Correct only in a backend, which is the only kind of process that declares a
 * runtime namespace. A CLI process has to name the namespace itself, and the way
 * to do that is to ask which deploy this checkout published:
 *
 *     const r = resolveCheckoutDeploy(root);
 *     if (r.kind === "resolved") worktreeArtifacts.webDist(r.deploy.namespace);
 *
 * This paragraph used to say `webDist(checkoutWorktreeName(root))`, which
 * builds a namespace out of a directory basename. It does not type-check
 * without an `asNamespace` cast, and that cast is now a lint error
 * (`namespace-identity/no-laundered-checkout-namespace`) — because it is a
 * guess either way: right for an agent worktree that has been built, and a
 * plausible stranger's dist for one that never was, or that serves a
 * composition instead.
 */
export function webDistDir(): AppPath {
  return (
    readEnvPath("WEB_DIST") ?? worktreeArtifacts.webDist(runtimeNamespace())
  );
}

// Claude Code's own dirs under the home dir: app-owned by claim (a path
// under home is wherever its segments say, so the lint cannot prove it).
export const CLAUDE_DIR = asAppPath(join(HOME_DIR, ".claude"));
export const CLAUDE_PROJECTS_DIR = joinAppPath(CLAUDE_DIR, "projects");
export const CLAUDE_SESSIONS_DIR = joinAppPath(CLAUDE_DIR, "sessions");

// Claude Code caps a projects dir name at this many characters, then appends
// a hash of the whole cwd so two long cwds sharing a prefix stay apart.
const CLAUDE_PROJECT_DIR_MAX = 200;

/**
 * Claude Code's name for the projects dir a session's transcripts go in: its
 * cwd with every character outside `[A-Za-z0-9]` replaced by `-` — past 200
 * characters, the first 200 then `-<hash>` (the cwd's 32-bit `h*31+c` string
 * hash, absolute, base 36), as Claude Code itself spells it. The one copy of
 * that encoding — a transcript is found by it (`claudeTranscriptPath`) and a
 * moved data root renames dirs by it (`paths/root-migration`).
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= CLAUDE_PROJECT_DIR_MAX) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++)
    hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, CLAUDE_PROJECT_DIR_MAX)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Where Claude Code writes the transcript of `sessionId` run in `cwd`. An
 * empty `cwd` names no directory, so it throws rather than answer a path in
 * the projects dir itself.
 */
export function claudeTranscriptPath(cwd: string, sessionId: string): AppPath {
  if (cwd === "")
    throw new Error(`claudeTranscriptPath: no cwd for session ${sessionId}`);
  return joinAppPath(
    CLAUDE_PROJECTS_DIR,
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
}
// Claude Code's user config file (beside `~/.claude/`, not in it): per-directory
// state such as trust answers (`projects[<dir>].hasTrustDialogAccepted`).
export const CLAUDE_USER_CONFIG = asAppPath(join(HOME_DIR, ".claude.json"));
