import { mkdir, rm, writeFile } from "node:fs/promises";
import { exists, readdir } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { DepSource, Ready } from "./dep";
import { defaultStore, installPaths, type DepStore } from "./store";

const HOLDER = /^[a-z][a-z0-9-]*$/;

/**
 * Keep `ready`'s install from being swept while something OUTSIDE any checkout
 * still points at it — a launchd job naming the gateway binary by path, which
 * relaunches it after a crash or at the next login long after the checkout that
 * built it has moved to a newer identity.
 *
 * One hold per `holder` per dependency: holding a new identity releases the
 * holder's previous one, so a re-`start` hands the old binary back to the
 * sweep. A sealed payload (a release bundle's) is part of its bundle and never
 * swept, so holding it does nothing.
 */
export async function holdDep(
  ready: Ready<DepSource>,
  holder: string,
  opts: { store?: DepStore } = {},
): Promise<void> {
  if (!HOLDER.test(holder)) {
    throw new Error(
      `holdDep: holder ${JSON.stringify(holder)} must match ${HOLDER}`,
    );
  }
  const store = opts.store ?? defaultStore();
  const paths = installPaths(store, ready.dep.id, ready.identity);
  if (paths.env !== ready.dir) return;
  const idDir = join(store.cacheRoot, ready.dep.id);
  for (const identity of await readdir(idDir)) {
    if (identity === ready.identity) continue;
    await rm(join(installPaths(store, ready.dep.id, identity).holds, holder), {
      force: true,
    });
  }
  await mkdir(paths.holds, { recursive: true });
  await writeFile(join(paths.holds, holder), `${new Date().toISOString()}\n`);
}

/** Whether anything holds this install (see {@link holdDep}). */
export async function isHeld(paths: { holds: string }): Promise<boolean> {
  return (await exists(paths.holds)) && (await readdir(paths.holds)).length > 0;
}
