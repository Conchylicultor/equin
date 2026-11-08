import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import {
  exists,
  lstat,
  readdir,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { randomUUID } from "node:crypto";
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
  const sealed = await sealedLookup(dep, root);
  if (sealed.kind === "ready") return sealed.ready;
  if (sealed.kind === "failed") throw new Error(sealed.message);

  const { identity, paths } = await installInCache(dep, dep.source, exec, {
    root,
    store: opts.store ?? (await defaultStore()),
    say: opts.log ?? (() => {}),
  });
  return await found(dep, paths, identity);
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

  if (await isInstalled(source, paths)) return { identity, paths };

  const fd = await waitLock(paths.lock, () =>
    say(
      `another process is installing ${dep.id} (${identity}); waiting for it`,
    ),
  );
  try {
    // Whoever held the lock may have just finished this very install.
    if (!(await isInstalled(source, paths))) {
      await install({ dep, source, root, paths, identity, inputs, exec, say });
    }
    return { identity, paths };
  } finally {
    await releaseLock(fd);
  }
}

/** `ready.json` present, and the payload still whole by the kind's own test. */
async function isInstalled(
  source: DepSource,
  paths: InstallPaths,
): Promise<boolean> {
  if (!(await exists(paths.ready))) return false;
  return (await source.isIntact?.(paths.env)) ?? true;
}

async function found<S extends DepSource>(
  dep: Dep<S>,
  paths: InstallPaths,
  identity: string,
): Promise<Ready<S>> {
  await writeFile(paths.lastUsed, `${new Date().toISOString()}\n`);
  return mintReady(dep, paths.env, identity);
}

/** Write a small JSON file so a reader never sees half of it. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  // Unique per call: two writes of one file may now interleave.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

/** Total bytes under `dir`, symlinks counted as themselves (never followed). */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else total += (await lstat(path)).size;
    }
  }
  return total;
}

/** The bytes a log grew by since `from`, as text. */
async function readFrom(path: string, from: number): Promise<string> {
  const size = (await stat(path)).size;
  if (size <= from) return "";
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    await handle.read(buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    await handle.close();
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
  await mkdir(paths.root, { recursive: true });
  // A partial payload from an interrupted install, and the last failure, go.
  // A `ready.json` over a payload that is no longer intact goes first, so the
  // identity reads as not installed until this install finishes.
  await rm(paths.ready, { force: true });
  await rm(paths.env, { recursive: true, force: true });
  await rm(paths.failed, { force: true });
  // The install log holds one install: truncated here, written only by this
  // install (its header, then each command's output appended by the child's
  // own shell), removed with its identity dir. That is its whole bound.
  await writeFile(
    paths.log,
    `installing ${dep.id} (${source.kind}: ${source.label}) at ${identity}\n`,
  );
  await writeJsonAtomic(paths.installing, {
    since: new Date().toISOString(),
    pid: process.pid,
  });

  const log = say;
  const run: InstallContext["run"] = async (argv, runOpts) => {
    say(`$ ${argv.join(" ")}`);
    const from = (await stat(paths.log)).size;
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
    const output = await readFrom(paths.log, from);
    for (const line of output.split("\n").map(screenLine)) {
      if (line !== "" && !line.startsWith("$ ")) say(line);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `\`${argv.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}):\n` +
          (await logTail(paths.log, 30)).join("\n"),
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
    if (!(await exists(paths.env))) {
      throw new Error(
        `the ${source.kind} installer finished without creating ${paths.env}`,
      );
    }
    const ready: ReadyFile = {
      identity,
      installedAt: new Date().toISOString(),
      bytes: await dirBytes(paths.env),
      inputs: { ...inputs },
    };
    await writeJsonAtomic(paths.ready, ready);
    log(
      `installed ${dep.id} in ${Math.round((Date.now() - started) / 1000)} s (${(ready.bytes / 1e6).toFixed(1)} MB)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeJsonAtomic(paths.failed, {
      message,
      at: new Date().toISOString(),
    });
    log(`install failed: ${message}`);
    throw err;
  } finally {
    await rm(paths.installing, { force: true });
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
  return { kind: "ready", ready: await found(dep, at.paths, at.identity) };
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
  const sealed = await sealedLookup(dep, root);
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
  const store = opts.store ?? (await defaultStore());
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
  const state = await readInstallState(
    paths,
    async (dir) => (await dep.source.isIntact?.(dir)) ?? true,
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
  if ((await sealedLookup(dep, root)).kind !== "unsealed") {
    throw new Error(
      `${dep.id}: ${root} is a sealed release bundle; its dependencies are part of it and cannot be removed.`,
    );
  }
  const store = opts.store ?? (await defaultStore());
  const { identity } = await currentIdentity(dep, root);
  const paths = installPaths(store, dep.id, identity);
  if (!(await exists(paths.root))) return { kind: "absent" };
  const fd = await tryLock(paths.lock);
  if (fd === null) return { kind: "busy" };
  try {
    const bytes = (await exists(paths.ready))
      ? (await readJson(paths.ready, ReadyFileSchema)).bytes
      : 0;
    // Async: this runs on a backend's event loop (the remove endpoint), and a
    // Python env is tens of thousands of files.
    await rm(paths.root, { recursive: true, force: true });
    return { kind: "removed", bytes };
  } finally {
    await releaseLock(fd);
  }
}
