import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import type { DepState } from "../../core";
import {
  mintReady,
  type Dep,
  type DepSource,
  type InstallContext,
  type Ready,
} from "./dep";
import { releaseLock, tryLock, waitLock } from "./lock";
import {
  logTail,
  readInstallState,
  screenLine,
  readJson,
  ReadyFileSchema,
  type ReadyFile,
} from "./state";
import { sealedLookup } from "./sealed";
import {
  currentIdentity,
  defaultStore,
  installPaths,
  sourceIdentity,
  type DepStore,
  type InstallPaths,
} from "./store";

export interface EnsureOptions {
  /** Where progress lines go besides the install log (a job's transcript, the terminal). */
  log?: (line: string) => void;
  /** The checkout whose declaration to derive the identity from. Default: this one. */
  root?: AppPath;
  /** Test seam: the cache and lock dirs. */
  store?: DepStore;
}

/**
 * Make sure `dep` is installed at its current identity, installing it if not,
 * and return the proof.
 *
 * It never runs on a backend's event loop, by type: `exec` is an
 * `ExecContext`, which only a supervised job's run body and a CLI command can
 * produce. A request handler uses `requestDep` instead.
 *
 * Fast path: `ready.json` present → touch `last-used`, return. Slow path: take
 * the host flock of `(id, identity)` (waiting for another installer), re-check,
 * then install into the identity's dir under the caller's host admission
 * (`exec.admit`, one background unit — unless the source declares
 * `admission: { none }`), writing `ready.json` last.
 */
export async function ensureDep<S extends DepSource>(
  dep: Dep<S>,
  exec: ExecContext,
  opts: EnsureOptions = {},
): Promise<Ready<S>> {
  const root = opts.root ?? REPO_ROOT;
  // A release bundle: the dependency is sealed in it, or it cannot be had —
  // there is no source, toolchain or network to install it from.
  const sealed = sealedLookup(dep, root);
  if (sealed.kind === "ready") return sealed.ready;
  if (sealed.kind === "failed") throw new Error(sealed.message);

  const { identity, paths } = await installInCache(dep, dep.source, exec, {
    root,
    store: opts.store ?? defaultStore(),
    say: opts.log ?? (() => {}),
  });
  return found(dep, paths, identity);
}

/**
 * `source` (the declaration's own, or one specialised for another target by
 * `sealDep`) installed in the host cache at its current identity: the fast
 * path, else the flock, a re-check and the install. Returns where it is.
 */
export async function installInCache(
  dep: Dep<DepSource>,
  source: DepSource,
  exec: ExecContext,
  opts: { root: AppPath; store: DepStore; say: (line: string) => void },
): Promise<{ identity: string; paths: InstallPaths }> {
  const { root, store, say } = opts;
  const { identity, inputs } = await sourceIdentity(source, root);
  const paths = installPaths(store, dep.id, identity);

  if (isInstalled(source, paths)) return { identity, paths };

  const fd = await waitLock(paths.lock, () =>
    say(
      `another process is installing ${dep.id} (${identity}); waiting for it`,
    ),
  );
  try {
    // Whoever held the lock may have just finished this very install.
    if (!isInstalled(source, paths)) {
      await install({ dep, source, root, paths, identity, inputs, exec, say });
    }
    return { identity, paths };
  } finally {
    releaseLock(fd);
  }
}

/** `ready.json` present, and the payload still whole by the kind's own test. */
function isInstalled(source: DepSource, paths: InstallPaths): boolean {
  if (!existsSync(paths.ready)) return false;
  return source.isIntact?.(paths.env) ?? true;
}

function found<S extends DepSource>(
  dep: Dep<S>,
  paths: InstallPaths,
  identity: string,
): Ready<S> {
  writeFileSync(paths.lastUsed, `${new Date().toISOString()}\n`);
  return mintReady(dep, paths.env, identity);
}

/** Write a small JSON file so a reader never sees half of it. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Total bytes under `dir`, symlinks counted as themselves (never followed). */
export function dirBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else total += lstatSync(path).size;
    }
  }
  return total;
}

/** The bytes a log grew by since `from`, as text. */
function readFrom(path: string, from: number): string {
  const size = statSync(path).size;
  if (size <= from) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function install(args: {
  dep: Dep<DepSource>;
  source: DepSource;
  root: AppPath;
  paths: InstallPaths;
  identity: string;
  inputs: Readonly<Record<string, string>>;
  exec: ExecContext;
  say: (line: string) => void;
}): Promise<void> {
  const { dep, source, root, paths, identity, inputs, exec, say } = args;
  mkdirSync(paths.root, { recursive: true });
  // A partial payload from an interrupted install, and the last failure, go.
  // A `ready.json` over a payload that is no longer intact goes first, so the
  // identity reads as not installed until this install finishes.
  rmSync(paths.ready, { force: true });
  rmSync(paths.env, { recursive: true, force: true });
  rmSync(paths.failed, { force: true });
  // The install log holds one install: truncated here, written only by this
  // install (its header, then each command's output appended by the child's
  // own shell), removed with its identity dir. That is its whole bound.
  writeFileSync(
    paths.log,
    `installing ${dep.id} (${source.kind}: ${source.label}) at ${identity}\n`,
  );
  writeJsonAtomic(paths.installing, {
    since: new Date().toISOString(),
    pid: process.pid,
  });

  const log = say;
  const run: InstallContext["run"] = async (argv, runOpts) => {
    say(`$ ${argv.join(" ")}`);
    const from = statSync(paths.log).size;
    // The child appends straight to the install log, so `logTail` follows a
    // long install while it runs; `$0` is the log, `$@` the command.
    const result = await spawnCaptured(
      [
        "sh",
        "-c",
        'printf "$ %s\\n" "$*" >>"$0"; "$@" >>"$0" 2>&1',
        paths.log,
        ...argv,
      ],
      runOpts,
    );
    const output = readFrom(paths.log, from);
    for (const line of output.split("\n").map(screenLine)) {
      if (line !== "" && !line.startsWith("$ ")) say(line);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `\`${argv.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}):\n` +
          logTail(paths.log, 30).join("\n"),
      );
    }
  };

  const started = Date.now();
  say(`installing ${dep.id} (${source.kind}: ${source.label}) at ${identity}`);
  try {
    const installNow = () =>
      source.install({ root, dir: paths.env, log, run, exec });
    // A source that declares it needs no admission (see `DepSource.admission`)
    // installs at once; every other one under the caller's host admission.
    await (source.admission === undefined
      ? exec.admit(installNow)
      : installNow());
    if (!existsSync(paths.env)) {
      throw new Error(
        `the ${source.kind} installer finished without creating ${paths.env}`,
      );
    }
    const ready: ReadyFile = {
      identity,
      installedAt: new Date().toISOString(),
      bytes: dirBytes(paths.env),
      inputs: { ...inputs },
    };
    writeJsonAtomic(paths.ready, ready);
    log(
      `installed ${dep.id} in ${Math.round((Date.now() - started) / 1000)} s (${(ready.bytes / 1e6).toFixed(1)} MB)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJsonAtomic(paths.failed, { message, at: new Date().toISOString() });
    log(`install failed: ${message}`);
    throw err;
  } finally {
    rmSync(paths.installing, { force: true });
  }
}

/** Where `dep` stands at its current identity. Safe on a backend's event loop. */
export async function depState(
  dep: Dep<DepSource>,
  opts: { root?: AppPath; store?: DepStore } = {},
): Promise<DepState> {
  const at = await locate(dep, opts);
  if (at.kind === "sealed") {
    // A bundle's payload is part of the bundle: nothing tracks its use.
    return {
      kind: "ready",
      identity: at.ready.identity,
      bytes: at.bytes,
      lastUsed: null,
    };
  }
  return at.kind === "located" ? at.state : at.failed;
}

/**
 * What {@link readyNow} answers: the proof, when `dep` is installed at its
 * current identity, or where it stands otherwise.
 */
export type ReadyNow<S extends DepSource = DepSource> =
  { kind: "ready"; ready: Ready<S> } | Exclude<DepState, { kind: "ready" }>;

/**
 * The proof that `dep` is installed, when it already is — WITHOUT installing
 * it. `ensureDep`'s fast path, safe on a backend's event loop: a request path
 * that needs an installed dependency (a lookup, a page read) takes the
 * `ready` arm's `Ready` and, on any other arm, asks for the install with
 * `requestDep` and answers "not available yet" — never a stand-in result.
 *
 * A `ready` answer counts as a use (`last-used`), as `ensureDep`'s does.
 */
export async function readyNow<S extends DepSource>(
  dep: Dep<S>,
  opts: { root?: AppPath; store?: DepStore } = {},
): Promise<ReadyNow<S>> {
  const at = await locate(dep, opts);
  if (at.kind === "failed") return at.failed;
  if (at.kind === "sealed") return { kind: "ready", ready: at.ready };
  if (at.state.kind !== "ready") return at.state;
  return { kind: "ready", ready: found(dep, at.paths, at.identity) };
}

/**
 * `dep`'s current identity, its files and the state on disk — or `failed`
 * when the identity cannot be derived (the installer is missing): nothing can
 * be installed until that is fixed, which is a failure, not "absent".
 */
async function locate<S extends DepSource>(
  dep: Dep<S>,
  opts: { root?: AppPath; store?: DepStore },
): Promise<
  | { kind: "located"; identity: string; paths: InstallPaths; state: DepState }
  | { kind: "sealed"; ready: Ready<S>; bytes: number }
  | { kind: "failed"; failed: Extract<DepState, { kind: "failed" }> }
> {
  const root = opts.root ?? REPO_ROOT;
  const sealed = sealedLookup(dep, root);
  if (sealed.kind === "ready") {
    return { kind: "sealed", ready: sealed.ready, bytes: sealed.bytes };
  }
  if (sealed.kind === "failed") {
    return {
      kind: "failed",
      failed: {
        kind: "failed",
        message: sealed.message,
        at: new Date().toISOString(),
      },
    };
  }
  const store = opts.store ?? defaultStore();
  let identity: string;
  try {
    identity = (await currentIdentity(dep, root)).identity;
  } catch (err) {
    return {
      kind: "failed",
      failed: {
        kind: "failed",
        message: `cannot derive the identity: ${err instanceof Error ? err.message : String(err)}`,
        at: new Date().toISOString(),
      },
    };
  }
  const paths = installPaths(store, dep.id, identity);
  const state = readInstallState(
    paths,
    (dir) => dep.source.isIntact?.(dir) ?? true,
  );
  return { kind: "located", identity, paths, state };
}

/** The outcome of {@link removeDep}. */
export type RemoveOutcome =
  { kind: "removed"; bytes: number } | { kind: "absent" } | { kind: "busy" };

/**
 * Remove `dep`'s install at its current identity, back to `absent`. Refuses
 * (`busy`) while any process holds its lock — an install, or the sweep.
 */
export async function removeDep(
  dep: Dep<DepSource>,
  opts: { root?: AppPath; store?: DepStore } = {},
): Promise<RemoveOutcome> {
  const root = opts.root ?? REPO_ROOT;
  if (sealedLookup(dep, root).kind !== "unsealed") {
    throw new Error(
      `${dep.id}: ${root} is a sealed release bundle; its dependencies are part of it and cannot be removed.`,
    );
  }
  const store = opts.store ?? defaultStore();
  const { identity } = await currentIdentity(dep, root);
  const paths = installPaths(store, dep.id, identity);
  if (!existsSync(paths.root)) return { kind: "absent" };
  const fd = tryLock(paths.lock);
  if (fd === null) return { kind: "busy" };
  try {
    const bytes = existsSync(paths.ready)
      ? readJson(paths.ready, ReadyFileSchema).bytes
      : 0;
    // Async: this runs on a backend's event loop (the remove endpoint), and a
    // Python env is tens of thousands of files.
    await rm(paths.root, { recursive: true, force: true });
    return { kind: "removed", bytes };
  } finally {
    releaseLock(fd);
  }
}
