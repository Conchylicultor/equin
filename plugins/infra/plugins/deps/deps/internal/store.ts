import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createHash } from "node:crypto";
import { depsCacheDir, depsLocksDir } from "../../data-dirs";
import type { Dep, DepSource } from "./dep";

/**
 * Where the engine keeps installs and locks. The real store is the declared
 * data dirs; a test hands its own temp dirs. (Host admission is not the
 * store's: it comes with the caller's `ExecContext`, `exec.admit`.)
 */
export interface DepStore {
  /** `<cacheRoot>/<id>/<identity>/…` */
  readonly cacheRoot: AppPath;
  /** `<locksRoot>/<id>-<identity>.lock` */
  readonly locksRoot: AppPath;
}

export async function defaultStore(): Promise<DepStore> {
  const [cacheRoot, locksRoot] = await Promise.all([
    depsCacheDir.ensure(),
    depsLocksDir.ensure(),
  ]);
  return { cacheRoot, locksRoot };
}

/**
 * The identity of a set of declared inputs: the kind plus every input, hashed.
 * Nothing is typed in by hand, so a change in any input is a new identity.
 */
export function identityOf(
  kind: string,
  inputs: Readonly<Record<string, string>>,
): string {
  const entries = Object.keys(inputs)
    .sort()
    .map((key) => [key, inputs[key]]);
  const canonical = JSON.stringify({ kind, inputs: entries });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** A dependency's current identity, derived from the checkout at `root`. */
export async function currentIdentity(
  dep: Dep<DepSource>,
  root: AppPath,
): Promise<{ identity: string; inputs: Readonly<Record<string, string>> }> {
  return sourceIdentity(dep.source, root);
}

/** The identity of one source (a declaration's own, or one for another target). */
export async function sourceIdentity(
  source: DepSource,
  root: AppPath,
): Promise<{ identity: string; inputs: Readonly<Record<string, string>> }> {
  const inputs = await source.identityInputs(root);
  return { identity: identityOf(source.kind, inputs), inputs };
}

/** The files of one `(id, identity)` install. */
export interface InstallPaths {
  readonly root: AppPath;
  readonly env: AppPath;
  readonly ready: AppPath;
  readonly installing: AppPath;
  readonly failed: AppPath;
  readonly log: AppPath;
  readonly lastUsed: AppPath;
  /** `holds/<holder>`: a durable reference from outside any checkout (see `holdDep`). */
  readonly holds: AppPath;
  readonly lock: AppPath;
}

export function installPaths(
  store: DepStore,
  id: string,
  identity: string,
): InstallPaths {
  const root = joinAppPath(store.cacheRoot, id, identity);
  return {
    root,
    env: joinAppPath(root, "env"),
    ready: joinAppPath(root, "ready.json"),
    installing: joinAppPath(root, "installing.json"),
    failed: joinAppPath(root, "failed.json"),
    log: joinAppPath(root, "install.log"),
    lastUsed: joinAppPath(root, "last-used"),
    holds: joinAppPath(root, "holds"),
    lock: joinAppPath(store.locksRoot, `${id}-${identity}.lock`),
  };
}
