import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { exists, realpath } from "@plugins/packages/plugins/timed-fs/core";
import {
  getMainRepoRoot,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import {
  checkoutAdminDir,
  stampMainSlot,
} from "@plugins/infra/plugins/paths/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { ensureDeps } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  addCheckout,
  withWorktreeMutateSlot,
} from "@plugins/infra/plugins/worktree/server";
import {
  clearUnserved,
  mainSlotsDir,
  markSlotHanded,
  readSlotHanded,
  slotStates,
  tryExclusiveLease,
  waitExclusiveLease,
  withSlotPool,
  type SlotHandoffHold,
  type SlotLease,
  type SlotState,
} from "../../core";
import type { SlotHolder } from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { fileOnExhausted } from "./file-reports";
import { reclaimSlots, type ReclaimOptions } from "./reclaim";
import { claimStaging, discardDebris } from "./pool-debris";

/**
 * The leak limit: as many slots may drain at once before a build stops
 * making new ones and waits for the oldest draining one. Draining slots
 * piling up mean processes outlive their apps' switches — a leak, reported.
 */
export const DRAINING_SLOT_LIMIT = 3;

/**
 * While a build waits on a draining slot past the leak limit, the
 * `main-slots-exhausted` report is filed again this often — a stalled main
 * deploy stays visible for as long as it stalls. The wait itself never gives
 * up: failing main's deploy over a leak would turn a slow drain into an
 * outage.
 */
export const EXHAUSTED_REFILE_MS = 10 * 60_000;

/** One draining slot and its holders, as seen when the leak limit was hit. */
export interface HeldSlot {
  slot: AppPath;
  /** When it stopped serving (`null`: not stamped yet). */
  unservedAt: string | null;
  holders: SlotHolder[];
}

/** A slot checked out at the build's commit, held exclusively for the build. */
export interface BuildSlot {
  slot: AppPath;
  lease: SlotLease;
  /** Made by this call (`git worktree add`), rather than reused. */
  created: boolean;
  /**
   * `null` when a slot was free (or made). Otherwise the leak limit was hit:
   * every draining slot and its holders as found, before the build waited on
   * the oldest — what the `main-slots-exhausted` report names.
   */
  waitedOn: HeldSlot[] | null;
}

export interface AcquireBuildSlotOptions {
  /** The repository the slots are worktrees of. Default: this checkout's repo. */
  repoRoot?: AppPath;
  /** The leak limit. Default {@link DRAINING_SLOT_LIMIT}. */
  drainingLimit?: number;
  /** Bring the slot's `node_modules` in line with its lockfile. Default: `ensureDeps`. */
  installDeps?: (slot: AppPath) => Promise<void>;
  /**
   * Called before waiting when the leak limit is hit — so it is reported
   * while the wait is still on — and again every `exhaustedRefileMs` the
   * wait lasts (`waitingMs`: how long it has waited, 0 the first time).
   * Default: file a `main-slots-exhausted` report through the outbox.
   */
  onExhausted?: (
    draining: HeldSlot[],
    waitedOn: AppPath,
    waitingMs: number,
  ) => void | Promise<void>;
  /**
   * The checkout this process runs from — never waited on (it drains only
   * once this process exits). Default: this process's `REPO_ROOT`.
   */
  ownRoot?: AppPath;
  /** How often a leak-limit wait is reported again. Default {@link EXHAUSTED_REFILE_MS}. */
  exhaustedRefileMs?: number;
  /** The lease's label (the build's id). Default `build`. */
  label?: string;
  /** Cancels a slot's creation or a leak-limit wait. */
  signal?: AbortSignal;
  /**
   * Called once a leak-limit wait was granted its slot, before the slot is
   * re-checked under the pool lock. Tests only: what changed during the wait.
   */
  afterWait?: (slot: AppPath) => Promise<void>;
}

/** A detached checkout in an existing slot is ~0.5 s. */
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;

async function nextSlotPath(): Promise<AppPath> {
  for (let n = 1; ; n++) {
    const path = joinAppPath(mainSlotsDir(), `slot-${n}`);
    if (!(await exists(path))) return path;
  }
}

/**
 * Make a slot's checkout at `sha` — OUTSIDE the pool lock, in a claimed
 * staging dir no listing reads (`pool-debris.ts`): `infra/worktree`'s add
 * (not `git worktree add`, which dies beside another add half-way through
 * writing its admin entry), under the host-wide worktree-mutate gate every
 * full-tree checkout takes, then the main-slot stamp. Whole when it returns;
 * {@link publishSlot} moves it into the pool. On a failure, what it made is
 * deleted (a kill leaves it to the sweep).
 */
async function stageSlot(
  repoRoot: AppPath,
  sha: string,
  signal?: AbortSignal,
): Promise<{ staging: AppPath; release: () => Promise<void> }> {
  const claimed = await claimStaging();
  try {
    // Every file written: the tree pool holds agent checkouts, not slots.
    // Foreground, like a spare's tree write: it holds a `worktree-mutate`
    // slot agent launches queue on (worktree's checkout-tier.ts).
    await withWorktreeMutateSlot(
      () =>
        addCheckout(
          `main slot ${claimed.path}`,
          repoRoot,
          claimed.path,
          { kind: "detached", rev: sha },
          { recycle: false, onStep: () => {}, tier: "foreground" },
          signal,
        ),
      signal,
    );
    await stampMainSlot(claimed.path);
  } catch (err) {
    try {
      await discardDebris(claimed.path);
    } finally {
      await claimed.release();
    }
    throw err;
  }
  return { staging: claimed.path, release: claimed.release };
}

/**
 * Publish a staged checkout as the pool's next slot — under the pool lock, so
 * it appears whole to a listing, and is taken by the caller before anyone
 * else can pick it. Its registration's `gitdir` is pointed at the new path
 * first (an atomic replace), then the dir renamed in: a kill between the two
 * leaves an unpublished staging dir for the sweep, never a listed slot whose
 * registration names a path that is gone.
 */
async function publishSlot(staging: AppPath): Promise<AppPath> {
  const path = await nextSlotPath();
  const admin = await checkoutAdminDir(staging);
  if (admin === null)
    throw new Error(`main-slots: ${staging} was staged but is not a checkout`);
  const entry = dirname(admin);
  const tmp = join(entry, `gitdir.${process.pid}.tmp`);
  await writeFile(tmp, `${join(path, ".git")}\n`);
  await rename(tmp, join(entry, "gitdir"));
  await rename(staging, path);
  return path;
}

/**
 * A slot for a build of `sha`, held exclusively. Never one an app lives in
 * (`slotStates`: serving), nor one being built or still draining — even at
 * the same commit: a build writes generated files and caches into its slot,
 * which would be the original bug under a running process.
 *
 * 1. a free slot, least recently served first, taken without waiting;
 * 2. else, while fewer slots drain than the leak limit, a new one (a detached
 *    linked worktree: ~6 s plus the install) — the last free one is still
 *    draining, which is normal;
 * 3. else the oldest draining one, waited for — `onExhausted` /
 *    `waitedOn` name every draining slot's holders, and `onExhausted` runs
 *    again every `exhaustedRefileMs` the wait lasts (it never gives up).
 *    Never the slot this process itself runs from (a convergence run holds
 *    its own as `build-relay` until it exits): with only that one draining
 *    past the limit, a slot is made instead.
 *
 * The choice runs under the pool lock (`withSlotPool`), and only quick steps
 * do: a new slot's checkout is staged outside it and published (renamed into
 * the pool and taken) under it; the wait runs outside it, and the slot it was
 * granted is re-checked under it — let go, and the choice made again, when it
 * vanished, serves an app or was handed to a build meanwhile.
 *
 * Then its unserved stamp is cleared (it is being built), `git checkout
 * --force --detach <sha>` (forced, so leftovers of the slot's last build never
 * count as the tree's state) and the install. On any failure past the lease,
 * the lease is released and the error rethrown.
 */
export async function acquireBuildSlot(
  sha: string,
  opts: AcquireBuildSlotOptions = {},
): Promise<BuildSlot> {
  const repoRoot = opts.repoRoot ?? (await getMainRepoRoot(REPO_ROOT));
  const limit = opts.drainingLimit ?? DRAINING_SLOT_LIMIT;
  const label = opts.label ?? "build";
  const installDeps =
    opts.installDeps ??
    (async (slot: AppPath) => {
      await ensureDeps({ root: slot });
    });

  const ownReal = await realpath(opts.ownRoot ?? REPO_ROOT);
  const notOwn = async (slots: SlotState[]): Promise<SlotState[]> => {
    const out: SlotState[] = [];
    for (const s of slots) {
      let real: string;
      try {
        real = await realpath(s.path);
      } catch (err) {
        // Reclaimed since it was listed (the reminder reads outside the
        // pool lock): no longer a slot to wait on.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (real !== ownReal) out.push(s);
    }
    return out;
  };
  // Picked under the pool lock: the states read and the slot taken are one
  // step, so no reclaim removes the slot, and no hander marks it, between
  // the two.
  const choose = (): Promise<Choice> =>
    withSlotPool(async (): Promise<Choice> => {
      const states = await slotStates();
      for (const s of states) {
        if (s.state !== "free") continue;
        const tried = await tryExclusiveLease(s.path, "build", label);
        if (tried.kind !== "acquired") continue;
        // Handed to a build since the states were read? (Never under the pool
        // lock, which handing takes too — a guard that costs one read.)
        if ((await readSlotHanded(s.path)) !== null) {
          await tried.lease.release();
          continue;
        }
        return { kind: "picked", slot: s.path, lease: tried.lease };
      }
      const draining = drainingOldestFirst(states);
      // The slot this process runs from (a convergence run's, held as
      // `build-relay`) drains only once this process exits: waiting on it
      // would never end.
      const others = await notOwn(draining);
      if (draining.length < limit || others.length === 0)
        return { kind: "create" };
      const held = others.map(heldSlotOf);
      return {
        kind: "wait",
        draining: held,
        // Which registration the slot is now: a slot reclaimed during the
        // wait and a new one published at its path have different ones.
        admin: await checkoutAdminDir(held[0]!.slot),
      };
    });

  const make = async (): Promise<{ slot: AppPath; lease: SlotLease }> => {
    const staged = await stageSlot(repoRoot, sha, opts.signal);
    try {
      return await withSlotPool(async () => {
        const slot = await publishSlot(staged.staging);
        const tried = await tryExclusiveLease(slot, "build", label);
        if (tried.kind !== "acquired") {
          throw new Error(
            `main-slots: ${slot} was just made and is already held by ${JSON.stringify(tried.holders)}`,
          );
        }
        return { slot, lease: tried.lease };
      });
    } catch (err) {
      // Not published: the staged checkout is ours to delete.
      if (await exists(staged.staging)) await discardDebris(staged.staging);
      throw err;
    } finally {
      await staged.release();
    }
  };

  let picked: { slot: AppPath; lease: SlotLease };
  let created = false;
  let waitedOn: HeldSlot[] | null = null;
  const onExhausted = opts.onExhausted ?? fileOnExhausted(limit);
  for (;;) {
    const choice = await choose();
    if (choice.kind === "picked") {
      picked = { slot: choice.slot, lease: choice.lease };
      break;
    }
    if (choice.kind === "create") {
      picked = await make();
      created = true;
      break;
    }
    // Waited for OUTSIDE the pool lock: a drain takes as long as its holders.
    waitedOn = choice.draining;
    const oldest = waitedOn[0]!.slot;
    const adminBefore = choice.admin;
    await onExhausted(waitedOn, oldest, 0);
    const sameSlot = async (): Promise<boolean> =>
      (await exists(oldest)) &&
      (await checkoutAdminDir(oldest)) === adminBefore;
    let lease: SlotLease;
    try {
      lease = await waitReminding(
        waitExclusiveLease(oldest, "build", label, { signal: opts.signal }),
        opts.exhaustedRefileMs ?? EXHAUSTED_REFILE_MS,
        async (waitingMs) => {
          const now = await notOwn(drainingOldestFirst(await slotStates()));
          await onExhausted(now.map(heldSlotOf), oldest, waitingMs);
        },
      );
    } catch (err) {
      // Granted on a slot reclaimed meanwhile (its registration gone, so
      // its holder record has nowhere to go): choose again. Anything else
      // is a failure.
      if (opts.signal?.aborted || (await sameSlot())) throw err;
      continue;
    }
    if (opts.afterWait !== undefined) await opts.afterWait(oldest);
    // Granted — but the pool moved on while we waited: the slot may have
    // been reclaimed (and another made at its path: our lock is the old
    // one's), picked and handed to a build, or made to serve an app.
    // Re-read under the pool lock.
    const stillOurs = await withSlotPool(async () => {
      if (!(await sameSlot())) return false;
      const s = (await slotStates()).find((x) => x.path === oldest);
      return s !== undefined && s.servedBy.length === 0 && s.handed === null;
    });
    if (stillOurs) {
      picked = { slot: oldest, lease };
      break;
    }
    await lease.release();
  }

  try {
    await clearUnserved(picked.slot);
    if (!created) {
      await spawnExpectOk(["git", "checkout", "--force", "--detach", sha], {
        cwd: picked.slot,
        timeoutMs: CHECKOUT_TIMEOUT_MS,
      });
    }
    await installDeps(picked.slot);
  } catch (err) {
    await picked.lease.release();
    throw err;
  }
  return { slot: picked.slot, lease: picked.lease, created, waitedOn };
}

type Choice =
  | { kind: "picked"; slot: AppPath; lease: SlotLease }
  | { kind: "create" }
  | { kind: "wait"; draining: HeldSlot[]; admin: AppPath | null };

/** The draining slots, oldest switch first; one not stamped yet is the newest. */
function drainingOldestFirst(states: SlotState[]): SlotState[] {
  return states
    .filter((s) => s.state === "draining")
    .sort(
      (a, b) =>
        (a.unserved === null ? Infinity : Date.parse(a.unserved.at)) -
        (b.unserved === null ? Infinity : Date.parse(b.unserved.at)),
    );
}

function heldSlotOf(s: SlotState): HeldSlot {
  return {
    slot: s.path,
    unservedAt: s.unserved?.at ?? null,
    holders: s.holders,
  };
}

/**
 * Await `wait`, calling `remind` every `everyMs` it is still pending (with
 * how long it has waited). Not polling: nothing is checked on the timer —
 * the wait is the kernel's (a flock grant); the timer only re-reports a
 * stall. A failing `remind` fails the wait loudly.
 */
async function waitReminding<T>(
  wait: Promise<T>,
  everyMs: number,
  remind: (waitingMs: number) => Promise<void>,
): Promise<T> {
  const start = Date.now();
  const settled = wait.then((value) => ({ value }));
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), everyMs);
    });
    let won: { value: T } | null;
    try {
      won = await Promise.race([settled, tick]);
    } finally {
      clearTimeout(timer);
    }
    if (won !== null) return won.value;
    await remind(Date.now() - start);
  }
}

/** A slot handed to a build that runs as a child process ({@link runInBuildSlot}). */
export interface HandedSlot {
  slot: AppPath;
  created: boolean;
  /**
   * The environment entries the child is started with: `EQUIN_BUILD_SLOT`
   * names the slot and `EQUIN_BUILD_SLOT_HANDOFF` the handoff it is marked
   * for, so the child takes its exclusive lease (`claimHandedBuildSlot`,
   * core) and the CLI bootstrap holds no shared one there (`boot-lease`).
   */
  env: Record<string, string>;
}

export interface RunInBuildSlotOptions extends AcquireBuildSlotOptions {
  /**
   * The reclaim every build ends with (`reclaimSlots`). Default: the real
   * one; a test passes its own options (a filer, a threshold).
   */
  reclaim?: ReclaimOptions;
}

/**
 * Prepare a slot for `sha` ({@link acquireBuildSlot}: exclusive, checked out,
 * installed), then hand it to `build` — the caller's CHILD process, which
 * builds in it and takes its lease itself: exclusive at its start, turned
 * shared when it hands the slot to the backend it restarts there, released
 * when it exits (`framework/cli/build`'s run.ts). A child holds it, not this
 * process, because only the child knows when that handover is due: a backend
 * restarted from the slot takes a shared lease at boot, which an exclusive
 * one held across the whole build would refuse — while the build waits for
 * that backend's health.
 *
 * Between this process releasing its lease and the child claiming it, the
 * slot is held by nobody — so it is first MARKED handed to one handoff id
 * (`markSlotHanded`, holding its hander lock): `acquireBuildSlot` skips a
 * slot whose hander lock is held (`slotStates`: building), and the child claims it
 * only when the mark names the id it was given. The mark is cleared by the
 * claim, and here once the build is over.
 *
 * Every build ends with `reclaimSlots` (stamp what stopped serving, file the
 * slow drains, delete free slots beyond one) — whatever the build's verdict.
 */
export async function runInBuildSlot<T>(
  sha: string,
  opts: RunInBuildSlotOptions,
  build: (slot: HandedSlot) => Promise<T>,
): Promise<T> {
  const acquired = await acquireBuildSlot(sha, opts);
  const handoff = randomUUID();
  let handed: SlotHandoffHold | null = null;
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    // Marked, then let go, as one step under the pool lock: no build picking
    // a slot sees it unheld and unmarked in between.
    handed = await withSlotPool(async () => {
      const hold = await markSlotHanded(acquired.slot, handoff);
      await acquired.lease.release();
      return hold;
    });
    result = {
      ok: true,
      value: await build({
        slot: acquired.slot,
        created: acquired.created,
        env: envEntries<string>({
          BUILD_SLOT: acquired.slot,
          BUILD_SLOT_HANDOFF: handoff,
        }),
      }),
    };
  } catch (error) {
    result = { ok: false, error };
  } finally {
    await acquired.lease.release();
    // Never marked (the mark step threw): nothing of ours to clear.
    if (handed !== null) await handed.release();
  }
  try {
    await reclaimSlots(opts.reclaim);
  } catch (reclaimError) {
    if (result.ok) throw reclaimError;
    throw new AggregateError(
      [result.error, reclaimError],
      "main-slots: the build and the reclaim after it both failed",
    );
  }
  if (!result.ok) throw result.error;
  return result.value;
}
