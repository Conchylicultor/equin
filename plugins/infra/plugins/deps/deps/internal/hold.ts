import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import {
  exists,
  readdir,
  readFile,
} from "@plugins/packages/plugins/timed-fs/core";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { isAbsolute, join } from "node:path";
import { mintReady, type Dep, type DepSource, type Ready } from "./dep";
import { defaultStore, installPaths, type DepStore } from "./store";

const HOLDER = /^[a-z][a-z0-9-]*$/;

/** How long a hold lasts. */
export interface HoldDepOptions {
  store?: DepStore;
  /**
   * Hold only while some process holds this lock file (a kernel flock): a
   * running process's reference, which must end with it however it dies —
   * a daemon run from a bundle that seals the install by reference
   * (`linkSealedDep`), holding its bundle's in-use lock for life. Take the
   * lock BEFORE holding: a hold whose lock is unheld (or gone) is stale, and
   * the next read deletes it. Absent: a durable hold, until the holder holds
   * another identity.
   */
  whileLocked?: string;
}

/**
 * Keep `ready`'s install from being swept or removed while something OUTSIDE
 * any checkout still points at it — a launchd job naming the gateway binary
 * by path, which relaunches it after a crash or at the next login long after
 * the checkout that built it has moved to a newer identity (durable); a
 * daemon running from a bundle that links it (`whileLocked`).
 *
 * One hold per `holder` per dependency: holding a new identity releases the
 * holder's previous one, so a re-`start` hands the old binary back to the
 * sweep. A sealed payload (a release bundle's) is part of its bundle and never
 * swept, so holding it does nothing.
 */
export async function holdDep(
  ready: Ready<DepSource>,
  holder: string,
  opts: HoldDepOptions = {},
): Promise<void> {
  if (!HOLDER.test(holder)) {
    throw new Error(
      `holdDep: holder ${JSON.stringify(holder)} must match ${HOLDER}`,
    );
  }
  if (opts.whileLocked !== undefined && !isAbsolute(opts.whileLocked)) {
    throw new Error(
      `holdDep: whileLocked ${JSON.stringify(opts.whileLocked)} must be an absolute path`,
    );
  }
  const store = opts.store ?? (await defaultStore());
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
  const file = join(paths.holds, holder);
  const text =
    opts.whileLocked === undefined
      ? `${new Date().toISOString()}\n`
      : `${JSON.stringify({ at: new Date().toISOString(), whileLocked: opts.whileLocked } satisfies LockedHold)}\n`;
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
  // A remove that ran between the caller's `Ready` and this hold took the
  // payload: say so here, not at the holder's first read of a dangling path.
  if (!(await exists(paths.ready))) {
    await rm(file, { force: true });
    throw new Error(
      `holdDep: ${ready.dep.id}@${ready.identity} was removed before ${holder} could hold it`,
    );
  }
}

/** A hold that lasts while its lock is held (`holdDep`'s `whileLocked`). */
interface LockedHold {
  at: string;
  whileLocked: string;
}

function parseLockedHold(text: string): LockedHold | null {
  // A durable hold is an ISO instant; a locked one is a JSON object.
  if (!text.trimStart().startsWith("{")) return null;
  const p = JSON.parse(text) as Partial<LockedHold> | null;
  if (
    p === null ||
    typeof p.whileLocked !== "string" ||
    typeof p.at !== "string"
  )
    throw new Error(`deps: hold ${JSON.stringify(text)} is malformed`);
  return { at: p.at, whileLocked: p.whileLocked };
}

/**
 * Whether some process holds `path` (a kernel flock) — an exclusive try, let
 * go at once. A missing file is unheld.
 */
async function lockHeld(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    return !flockTry(handle.fd);
  } finally {
    // Closing the descriptor drops whatever the try took.
    await handle.close();
  }
}

/**
 * The holders that hold this install now (see {@link holdDep}). A locked
 * hold whose lock nobody holds any more is stale: deleted here.
 */
export async function liveHolders(paths: { holds: string }): Promise<string[]> {
  if (!(await exists(paths.holds))) return [];
  const out: string[] = [];
  for (const name of (await readdir(paths.holds)).sort()) {
    if (name.endsWith(".tmp")) continue;
    const file = join(paths.holds, name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      // Released (or found stale by another reader) since the listing.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const locked = parseLockedHold(text);
    if (locked === null || (await lockHeld(locked.whileLocked))) {
      out.push(name);
      continue;
    }
    await rm(file, { force: true });
  }
  return out;
}

/** Whether anything holds this install (see {@link holdDep}). */
export async function isHeld(paths: { holds: string }): Promise<boolean> {
  return (await liveHolders(paths)).length > 0;
}

/** What {@link heldDep} found: the install `holder` holds, or none. */
export type HeldDep<S extends DepSource> =
  { kind: "held"; ready: Ready<S> } | { kind: "none" };

/**
 * The install of `dep` that `holder` holds (see {@link holdDep}) — the build
 * something outside any checkout runs, e.g. the gateway launchd relaunches —
 * when it is still installed and complete. A reload that must be able to go
 * back to what ran before reads it (the gateway's follow-main rollback).
 */
export async function heldDep<S extends DepSource>(
  dep: Dep<S>,
  holder: string,
  opts: { store?: DepStore } = {},
): Promise<HeldDep<S>> {
  const store = opts.store ?? (await defaultStore());
  const idDir = join(store.cacheRoot, dep.id);
  if (!(await exists(idDir))) return { kind: "none" };
  for (const identity of await readdir(idDir)) {
    const paths = installPaths(store, dep.id, identity);
    if (!(await exists(join(paths.holds, holder)))) continue;
    if (!(await exists(paths.ready))) continue;
    return { kind: "held", ready: mintReady(dep, paths.env, identity) };
  }
  return { kind: "none" };
}
