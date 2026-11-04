// Build leases: what keeps a build's in-flight cache entries out of the prune.
//
// Every write-once cache (artifact store, vendor sets, global-CSS cache) is
// shared by every checkout and pruned by the scheduled `web-artifacts.prune`
// job (it used to be pruned at the start of every checkout's build).
// A served dist protects the entries it links (`servedDistTargets`), but a build
// in progress links nothing until compose — minutes after it reused or
// published the entries it will compose. Without a lease, a concurrent build's
// prune deleted them in that window, and with many builds in flight compose
// never succeeded ("N mapped URL(s) do not resolve to a real file").
//
// The protocol makes that race impossible rather than unlikely:
//
// - A build PINS an entry before it reads or publishes it: a symlink to the
//   entry's absolute path in its own lease dir (`leases/<id>/`), written under a
//   SHARED flock on `store.lock`. Only after the pin returns does it check the
//   entry exists (reuse) or publish it (build).
// - A prune holds the EXCLUSIVE flock on `store.lock` for its whole run: it reads
//   its roots (served dists + every live lease) and deletes under that lock.
//
// So a pin and a prune never interleave. A pin that lands first is a root the
// prune sees; a prune that lands first is over before the build checks
// existence, and a removed entry is then simply built again. Either way, an
// entry a build verified after pinning stays until the lease is released —
// which the pipeline does once compose has linked everything into the staging
// dist (a `web.staging.*` dist, itself a root from then on). A release takes
// the lease down under the SHARED lock too, so a prune never reads a lease
// that is half removed.
//
// A lease holds the store lock at most once at a time: concurrent pins (a
// build pins ~1,700 artifacts at once) fold into one batch (`createCoalescer`),
// so a contended lock costs ONE waiter child per lease, never one per pin.
//
// Crash safety is the kernel's, the same way `.build.lock` is: a lease's owner
// holds an exclusive flock on its `owner.lock` for the lease's life, and the
// kernel drops it when the process dies (SIGKILL / OOM included). A prune that
// can take that lock knows the owner is gone and reaps the lease. No pid, no
// heartbeat, no age heuristic.

import { closeSync, mkdirSync, openSync, rmSync, symlinkSync } from "node:fs";
import {
  readdirSync,
  readlinkSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  appPathParent,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { randomBytes } from "node:crypto";
import {
  flockRelease,
  flockTry,
  flockTryShared,
  waitForFlock,
} from "@plugins/packages/plugins/flock/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { webArtifactsDir } from "../../data-dirs";
import {
  pruneCacheDir,
  surveyCacheDir,
  STORE_PRUNE_POLICY,
  type CachePrunePolicy,
} from "./store";
import { VENDOR_PRUNE_POLICY } from "./vendors";
import { CSS_PRUNE_POLICY } from "./global-css";
import { PACKAGE_ASSETS_PRUNE_POLICY } from "./package-assets";
import { refreshServedDists, scanServedDists } from "./served-dists";

/** Where the store lock and the leases live (a test passes its own). */
export interface LeaseLayout {
  /** The flock a pin takes shared and a prune exclusive. */
  lockFile: AppPath;
  /** One dir per live build lease. */
  leasesDir: AppPath;
}

const DEFAULT_LAYOUT: LeaseLayout = {
  lockFile: webArtifactsDir.file("store.lock"),
  leasesDir: webArtifactsDir.file("leases"),
};

const OWNER_LOCK = "owner.lock";

/**
 * Run `fn` holding the store lock (`shared` for a pin, `exclusive` for a
 * prune). The uncontended case is one in-process non-blocking flock; a
 * contended one waits push-based through `waitForFlock`'s child (never a poll).
 */
async function withStoreLock<T>(
  layout: LeaseLayout,
  mode: "shared" | "exclusive",
  fn: () => T,
): Promise<T> {
  mkdirSync(appPathParent(layout.lockFile), { recursive: true });
  const fd = openSync(layout.lockFile, "a");
  try {
    if (mode === "shared" ? flockTryShared(fd) : flockTry(fd)) {
      try {
        return fn();
      } finally {
        flockRelease(fd);
      }
    }
  } finally {
    closeSync(fd);
  }
  const held = await waitForFlock(layout.lockFile, {
    shared: mode === "shared",
  });
  try {
    return fn();
  } finally {
    await held.release();
  }
}

/** One build's lease over the cache entries it will compose. */
export interface BuildLease {
  /**
   * Pin absolute cache-entry paths. Resolves once every one is a prune root;
   * from then on an entry that exists stays until {@link release}. Check that
   * the entry exists (or publish it) only AFTER this resolves. Concurrent
   * calls share one store-lock acquisition.
   */
  pin(paths: readonly AppPath[]): Promise<void>;
  /**
   * Drop the lease (idempotent): waits for any pin in flight, then removes the
   * lease dir under the shared store lock. Its entries are ordinary cache
   * entries again.
   */
  release(): Promise<void>;
}

/**
 * Open a lease. Nothing touches the disk until the first pin, which creates
 * the lease dir and its owner lock under the shared store lock — so a prune
 * (exclusive) never sees a half-made lease.
 */
export function openBuildLease(
  layout: LeaseLayout = DEFAULT_LAYOUT,
): BuildLease {
  const dir = joinAppPath(
    layout.leasesDir,
    `${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const pinned = new Set<AppPath>();
  let ownerFd: number | null = null;

  const create = (): void => {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(joinAppPath(dir, OWNER_LOCK), "a");
    if (!flockTry(fd)) {
      closeSync(fd);
      throw new Error(
        `build lease ${dir}: its fresh owner lock is held by another process`,
      );
    }
    ownerFd = fd;
  };

  // One store-lock acquisition at a time for the whole lease: every pin that
  // lands while one is in flight folds into the ONE pending batch.
  const pinner = createCoalescer<AppPath>({
    run: (paths) =>
      withStoreLock(layout, "shared", () => {
        if (ownerFd === null) create();
        for (const path of paths) {
          if (pinned.has(path)) continue;
          symlinkSync(path, joinAppPath(dir, String(pinned.size)));
          pinned.add(path);
        }
      }),
  });
  let releasing: Promise<void> | null = null;

  return {
    async pin(paths) {
      if (releasing !== null) {
        throw new Error(`build lease ${dir}: pinned after release`);
      }
      // A path in an in-flight batch is not in `pinned` yet, so it rides the
      // next batch (a no-op there): a pin never resolves before its paths land.
      const fresh = paths.filter((p) => !pinned.has(p));
      if (fresh.length === 0) return;
      await pinner.run(fresh);
    },
    release() {
      releasing ??= (async () => {
        await pinner.idle();
        if (ownerFd === null) return; // never pinned anything
        const fd = ownerFd;
        await withStoreLock(layout, "shared", () => {
          rmSync(dir, { recursive: true, force: true });
        });
        closeSync(fd); // after the rm: a live owner's dir is never reaped
        ownerFd = null;
      })();
      return releasing;
    },
  };
}

/**
 * The entries every live lease pins; leases whose owner died are reaped.
 * Call ONLY under the exclusive store lock (a lease is created and released
 * under the shared one, so none is half-made or half-removed here).
 */
export function liveLeaseTargets(leasesDir: AppPath): Set<string> {
  const targets = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(leasesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return targets;
  }
  for (const name of names) {
    const dir = joinAppPath(leasesDir, name);
    let fd: number | null;
    try {
      fd = openSync(joinAppPath(dir, OWNER_LOCK), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fd = null; // no owner lock: the owner died mid-release
    }
    try {
      if (fd !== null && !flockTry(fd)) {
        // Held: the owner is alive, and its pins are roots.
        for (const link of readdirSync(dir)) {
          if (link === OWNER_LOCK) continue;
          targets.add(readlinkSync(joinAppPath(dir, link)));
        }
        continue;
      }
      rmSync(dir, { recursive: true, force: true }); // owner gone: reap
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return targets;
}

/** What one prune did, phase by phase (wall ms; counts of what it read). */
export interface PruneReport {
  /** Unlocked: every dist's links, then a stat of every non-root entry. */
  surveyMs: number;
  dists: number;
  distTargets: number;
  surveyedEntries: number;
  /** Waiting for the exclusive store lock. */
  lockWaitMs: number;
  /** Under the lock: leases, the dists that changed since, the deletes. */
  lockedMs: number;
  distsReread: number;
  removed: number;
}

/**
 * The ONE prune of every write-once cache. The roots are every entry a dist on
 * disk links (`servedDistTargets`) plus every entry a live build lease pins;
 * each cache is then pruned by its own policy (`pruneCacheDir`).
 *
 * Two phases, so the exclusive store lock — which every build's pins wait on —
 * is held for O(dists + victims), never O(every link of every dist):
 *
 * 1. Unlocked: scan every dist's links (`scanServedDists`, each dist stamped
 *    before it is read) and survey every cache dir (`surveyCacheDir`).
 * 2. Locked: read the live leases, re-read only the dists that are new or
 *    changed since their stamp (`refreshServedDists`), then judge the surveys
 *    against those roots and delete. Nothing that became a root after phase 1
 *    is lost: a lease is read here, a dist composed and published since phase 1
 *    has a new stamp, and an entry published since is in no survey.
 *
 * Not on any build's path: the scheduled `web-artifacts.prune` job runs it.
 * Concurrent prunes are serialized by the lock.
 */
export async function pruneWebArtifactCaches(
  opts: {
    layout?: LeaseLayout;
    worktrees?: AppPath;
    policies?: readonly CachePrunePolicy[];
  } = {},
): Promise<PruneReport> {
  const layout = opts.layout ?? DEFAULT_LAYOUT;
  const policies = opts.policies ?? [
    STORE_PRUNE_POLICY,
    VENDOR_PRUNE_POLICY,
    CSS_PRUNE_POLICY,
    PACKAGE_ASSETS_PRUNE_POLICY,
  ];
  const t0 = performance.now();
  const dists = scanServedDists(opts.worktrees);
  const surveys = policies.map((policy) => ({
    policy,
    survey: surveyCacheDir(policy.root, dists.targets),
  }));
  const t1 = performance.now();
  let t2 = t1;
  const locked = await withStoreLock(layout, "exclusive", () => {
    t2 = performance.now();
    const referenced = new Set(dists.targets);
    for (const t of liveLeaseTargets(layout.leasesDir)) referenced.add(t);
    const { reread } = refreshServedDists(dists, opts.worktrees);
    for (const t of dists.targets) referenced.add(t);
    let removed = 0;
    for (const { policy, survey } of surveys) {
      removed += pruneCacheDir({ ...policy, referenced, survey });
    }
    return { reread, removed };
  });
  return {
    surveyMs: t1 - t0,
    dists: dists.stamps.size,
    distTargets: dists.targets.size,
    surveyedEntries: surveys.reduce((n, s) => n + s.survey.entries.length, 0),
    lockWaitMs: t2 - t1,
    lockedMs: performance.now() - t2,
    distsReread: locked.reread,
    removed: locked.removed,
  };
}
