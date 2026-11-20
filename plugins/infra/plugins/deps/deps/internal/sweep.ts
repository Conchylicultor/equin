import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  exists,
  readdir,
  readFile,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Dep, DepSource } from "./dep";
import { isHeld } from "./hold";
import { releaseLock, tryLock } from "./lock";
import { declaredDeps } from "./registry";
import {
  currentIdentity,
  defaultStore,
  installPaths,
  type DepStore,
} from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An identity no checkout declares is removed once unused for this long. */
export const SWEEP_IDLE_MS = 14 * DAY_MS;

export interface SweepReport {
  removed: string[];
  kept: string[];
  /**
   * Checkouts whose identity of some dep could not be derived (skipped) —
   * only those asked: a dependency with an idle install, up to the checkout
   * where every one of them was found current.
   */
  underivable: string[];
}

/**
 * Remove every installed identity that is NOT current for any checkout's
 * declaration, NOT held (`holdDep`) AND has not been used for `idleMs`. Never one whose lock is held
 * (an install, or a process removing it): the lock is taken for the removal.
 *
 * A checkout where an identity cannot be derived (its installer is missing,
 * it predates the dep) contributes nothing to "current" — the idle window is
 * what protects its installs, so nothing recently used is ever removed.
 *
 * **Bounded by what can be removed, not by declarations × checkouts.** The
 * cheap facts come first: an identity used within the idle window, or held,
 * is kept without deriving anything. Only the rest — the candidates — need
 * "is it current somewhere?", and that is asked only of the dependencies that
 * have one, checkout by checkout, stopping once every candidate of the
 * dependency is found current. Deriving an identity spawns processes in the
 * checkout (a build kind's `git ls-files` per glob and its tool's version), so
 * asking every declaration of every checkout cost ~20 × ~450 derivations a
 * day — an hour of git under load (2026-11-20) — where a day's candidates
 * name a handful of dependencies.
 */
export async function sweepDeps(args: {
  store: DepStore;
  deps: readonly Dep<DepSource>[];
  checkouts: readonly AppPath[];
  now: Date;
  idleMs: number;
}): Promise<SweepReport> {
  const { store, deps, checkouts, now, idleMs } = args;
  const report: SweepReport = { removed: [], kept: [], underivable: [] };
  if (!(await exists(store.cacheRoot))) return report;

  // Installed identities the cheap facts keep go straight to `kept`; the
  // rest are candidates, by dependency id.
  const candidates = new Map<string, string[]>();
  for (const id of await readdir(store.cacheRoot)) {
    const idDir = join(store.cacheRoot, id);
    if (!(await stat(idDir)).isDirectory()) continue;
    for (const identity of await readdir(idDir)) {
      const paths = installPaths(store, id, identity);
      if (!(await stat(paths.root)).isDirectory()) continue;
      if (
        (await isHeld(paths)) ||
        now.getTime() - (await lastUsedAt(paths)) < idleMs
      ) {
        report.kept.push(`${id}/${identity}`);
        continue;
      }
      candidates.set(id, [...(candidates.get(id) ?? []), identity]);
    }
  }

  for (const [id, identities] of candidates) {
    // A dependency no checkout declares any more has no current identity.
    const dep = deps.find((d) => d.id === id);
    const notCurrent = new Set(identities);
    if (dep !== undefined) {
      for (const root of checkouts) {
        if (notCurrent.size === 0) break;
        try {
          notCurrent.delete((await currentIdentity(dep, root)).identity);
        } catch (err) {
          report.underivable.push(
            `${dep.id} @ ${root}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    for (const identity of identities) {
      const key = `${id}/${identity}`;
      if (!notCurrent.has(identity)) {
        report.kept.push(key);
        continue;
      }
      const paths = installPaths(store, id, identity);
      const fd = await tryLock(paths.lock);
      if (fd === null) {
        report.kept.push(key);
        continue;
      }
      try {
        // Read again under the lock: a use or a hold writes its file without
        // it, and the derivations above may have taken minutes since.
        if (
          (await isHeld(paths)) ||
          now.getTime() - (await lastUsedAt(paths)) < idleMs
        ) {
          report.kept.push(key);
          continue;
        }
        await rm(paths.root, { recursive: true, force: true });
        report.removed.push(key);
      } finally {
        await releaseLock(fd);
      }
    }
  }
  return report;
}

/** When an install was last used: `last-used`, else the dir's own mtime. */
async function lastUsedAt(
  paths: ReturnType<typeof installPaths>,
): Promise<number> {
  if (await exists(paths.lastUsed)) {
    const at = Date.parse((await readFile(paths.lastUsed, "utf8")).trim());
    if (!Number.isNaN(at)) return at;
  }
  return (await stat(paths.root)).mtimeMs;
}

/**
 * The daily sweep over this host's real store and every declared dependency:
 * `sweepDeps` with the defaults. The caller names the checkouts — listing
 * them is git worktree knowledge the engine does not carry (see the `sweep`
 * sub-plugin).
 */
export async function sweepUnusedDeps(args: {
  checkouts: readonly AppPath[];
  now: Date;
}): Promise<SweepReport> {
  return sweepDeps({
    store: await defaultStore(),
    deps: await declaredDeps(),
    checkouts: args.checkouts,
    now: args.now,
    idleMs: SWEEP_IDLE_MS,
  });
}
