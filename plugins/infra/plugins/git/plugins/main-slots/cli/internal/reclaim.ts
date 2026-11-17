import { rename, unlink } from "node:fs/promises";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { checkoutAdminDir } from "@plugins/infra/plugins/paths/core";
import {
  drainsByDesign,
  parseDrainRecord,
  SLOT_DRAIN_LOG_DIR,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import {
  reapDeadHolders,
  slotStates,
  stampUnservedSlots,
  tryExclusiveLease,
  withSlotPool,
  type DrainSlowPayload,
  type SlotLease,
  type SlotState,
} from "../../core";
import { readDrainReportAfterMs } from "./config-read";
import { fileDrainSlow } from "./file-reports";
import {
  claimTrash,
  discardDebris,
  removeTreeDefault,
  sweepDebris,
  type DebrisClaim,
  type RemoveTree,
} from "./pool-debris";

/** How many free slots reclaim keeps ready: one, for the next build. */
export const FREE_SLOTS_KEPT = 1;

export interface ReclaimOptions {
  /** The slow-drain threshold. Default: main's config (`drainReportAfterSec`). */
  drainReportAfterMs?: number;
  /** File one drain-slow report; whether it was written. Default: through the outbox. */
  fileDrainSlow?: (report: DrainSlowPayload) => Promise<boolean>;
  now?: Date;
  /** How a removed slot's tree is deleted. Default: a recursive `rm`. */
  removeTree?: RemoveTree;
}

export interface ReclaimOutcome {
  /** Drain reports filed (records released late, and holders still holding). */
  filed: DrainSlowPayload[];
  /** Free slots removed. */
  removed: AppPath[];
}

/**
 * Bring main's pool back to its steady state — the slots apps live in, plus
 * one free — and report the slow drains:
 *
 * 1. stamp every slot that serves no app and has no stamp yet as unserved
 *    (`stampUnservedSlots`, with the configured threshold);
 * 2. file a `main-slot-drain-slow` report per drain record a release left
 *    (the record is deleted once filed), and one per holder of a draining
 *    slot still holding it past the threshold;
 * 3. remove the free slots beyond {@link FREE_SLOTS_KEPT}, oldest first —
 *    each taken exclusively first (a build that took it in between wins) and
 *    renamed out of the pool (`.trash-<id>-<ms>`, claimed);
 * 4. then, OUTSIDE the pool lock, delete each removed slot — its own
 *    registration (never a repo-wide `git worktree prune`) under the
 *    worktree-mutate gate, then its tree — and sweep the debris a killed
 *    remover or maker left (`pool-debris.ts`).
 *
 * Steps 1–3 hold the pool lock (`withSlotPool`): a build picking a slot, a
 * link flip stamping slots, never see a slot half-removed — and they are
 * quick. The slow half (the gate waits on other checkouts' adds; a slot's
 * tree is ~GBs) runs after it is released, so no build pick, link flip or
 * lease downgrade waits behind a delete.
 *
 * Run at the end of every main build (`runInBuildSlot`) and by the daily
 * `main-slots.reclaim` job — the backstop for a slot freed by a process
 * killed with SIGKILL, whose end nothing announces.
 */
export async function reclaimSlots(
  opts: ReclaimOptions = {},
): Promise<ReclaimOutcome> {
  const removeTree = opts.removeTree ?? removeTreeDefault;
  const { outcome, trashed } = await withSlotPool(() => reclaimLocked(opts));
  // Every removed slot is deleted (or its claim let go, for the sweep to
  // retry) before a failure is thrown — none is left claimed by this process.
  const errors: unknown[] = [];
  for (const t of trashed) {
    try {
      await discardDebris(t.trash.path, removeTree);
    } catch (err) {
      errors.push(err);
    } finally {
      await t.lease.release();
      await t.trash.release();
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "main-slots: deleting reclaimed slots failed",
    );
  await sweepDebris(removeTree);
  return outcome;
}

/** A slot renamed out of the pool, still to delete — its lease and its trash claim held. */
interface Trashed {
  trash: DebrisClaim;
  lease: SlotLease;
}

async function reclaimLocked(
  opts: ReclaimOptions,
): Promise<{ outcome: ReclaimOutcome; trashed: Trashed[] }> {
  const now = opts.now ?? new Date();
  const threshold = opts.drainReportAfterMs ?? readDrainReportAfterMs();
  const file = opts.fileDrainSlow ?? fileDrainSlow;
  await stampUnservedSlots(threshold, now);
  const states = await slotStates();

  const filed: DrainSlowPayload[] = [];
  for (const s of states) {
    // A holder killed while holding left a record and no drain note: noted
    // now (found dead), before the records are filed. Not a slot handed to
    // or held by a build (a probe must not meet its claim), nor one an app
    // lives in (no stamp: nothing to note).
    if (s.state === "free" || s.state === "draining")
      await reapDeadHolders(s.path);
    for (const report of await drainRecordsOf(s)) {
      if (!(await file(report.payload))) continue;
      filed.push(report.payload);
      await unlink(report.file);
    }
    for (const report of stillHolding(s, now)) {
      if (await file(report)) filed.push(report);
    }
  }

  const free = states.filter((s) => s.state === "free");
  const extras = free.slice(0, Math.max(0, free.length - FREE_SLOTS_KEPT));
  const removed: AppPath[] = [];
  const trashed: Trashed[] = [];
  for (const s of extras) {
    const t = await unlistFreeSlot(s);
    if (t === null) continue;
    removed.push(s.path);
    trashed.push(t);
  }
  return { outcome: { filed, removed }, trashed };
}

async function drainRecordsOf(
  s: SlotState,
): Promise<{ file: AppPath; payload: DrainSlowPayload }[]> {
  const admin = await checkoutAdminDir(s.path);
  if (admin === null) return [];
  const dir = joinAppPath(admin, SLOT_DRAIN_LOG_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: { file: AppPath; payload: DrainSlowPayload }[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = joinAppPath(dir, name);
    const record = parseDrainRecord(file, await readFile(file, "utf8"));
    out.push({
      file,
      payload: {
        kind: record.kind,
        label: record.label,
        pid: record.pid,
        heldPastSwitchMs: record.heldPastSwitchMs,
        thresholdMs: record.thresholdMs,
        slot: record.slot,
        commit: record.commit,
        stillHolding: false,
        foundDead: record.foundDead,
      },
    });
  }
  return out;
}

/** The holders of a draining slot past its threshold, as reports. */
function stillHolding(s: SlotState, now: Date): DrainSlowPayload[] {
  if (s.state !== "draining" || s.unserved === null) return [];
  const heldPastSwitchMs = now.getTime() - Date.parse(s.unserved.at);
  if (heldPastSwitchMs <= s.unserved.reportAfterMs) return [];
  return s.holders
    .filter((h) => !drainsByDesign(h.kind))
    .map((h) => ({
      kind: h.kind,
      label: h.label,
      pid: h.pid,
      heldPastSwitchMs,
      thresholdMs: s.unserved!.reportAfterMs,
      slot: s.path,
      commit: null,
      stillHolding: true,
      foundDead: false,
    }));
}

/**
 * Take one free slot exclusively and rename it out of the pool (a claimed
 * trash path) — the quick half of its removal, under the pool lock; `null`
 * when something took it meanwhile. The lease is kept until its delete:
 * its lock lives in the slot's registration, which goes with it.
 */
async function unlistFreeSlot(s: SlotState): Promise<Trashed | null> {
  const tried = await tryExclusiveLease(s.path, "build", "reclaim");
  if (tried.kind === "held") return null;
  let trash: DebrisClaim | null = null;
  try {
    trash = await claimTrash(s.id);
    await rename(s.path, trash.path);
  } catch (err) {
    if (trash !== null) await trash.release();
    await tried.lease.release();
    throw err;
  }
  return { trash, lease: tried.lease };
}
