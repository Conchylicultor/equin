import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  PersistedBase,
  PersistedValueCheck,
  SeedOutcome,
} from "@plugins/framework/plugins/server-core/core";
import {
  clearPersistedSnapshots,
  readPersistedReadSets,
  readPersistedSnapshots,
} from "./persist";
import type { L2Expectation } from "./persist";
import {
  minPosition,
  probeCatchUp,
  readUsablePositions,
  replayCatchUp,
} from "./catch-up";
import type { ReplayRoute } from "./catch-up";
import { isPrunedPast, readPruneHorizon } from "./changelog-horizon";
import { snapshotLog as log } from "./log-sink";

/** The runtime calls the boot catch-up makes — injected, so a test can record them. */
export interface BootCatchUpRuntime {
  /** The persisted unbounded-window aliases (`unboundedWindowKeys()`). */
  aliasKeys: readonly string[];
  /** Schedule a FULL recompute of a param-less key (`recomputeResource`). */
  recompute: (key: string) => void;
  /**
   * Restore an alias's in-memory diff base and base floor
   * (`seedPersistedSnapshot`). `invalid` (A30): the value does not parse as
   * the entry's payload, so the row is treated as missing.
   */
  seed: (key: string, value: unknown, base: PersistedBase) => SeedOutcome;
  /** Route one replayed changelog row (change-feed's `routeChange`). */
  route?: ReplayRoute;
  /**
   * The rollups this boot's committed reconcile HEALED (derived-tables'
   * `reconciledRollups()`, rows upserted or deleted). A heal rewrites rollup
   * rows with no changelog entry (rollups are feed-exempt), so no persisted
   * value computed from the drifted rows can be proven current.
   */
  healedRollups: readonly string[];
}

/**
 * A heal blocks every persisted row from being served (A20). The boot
 * reconcile rewrote rollup rows with no changelog entry (rollups are
 * feed-exempt), and a reader may reach a rollup through a view, so no
 * persisted value computed before the heal can be proven current. Called in
 * `onReadyBlocking` — before readiness flips, so boot-snapshot's first read
 * (`readPersistedSnapshots`) finds none of them — and again by
 * `runBootCatchUp`, which then recomputes every key. Returns the rows removed.
 */
export async function clearHealedSnapshots(
  db: NodePgDatabase,
  exp: L2Expectation,
  healedRollups: readonly string[],
): Promise<number> {
  if (healedRollups.length === 0) return 0;
  return clearPersistedSnapshots(db, [...exp.persisted]);
}

/** The runtime calls the A30 barrier sweep makes — injected, so a test can stand them in. */
export interface InvalidAliasSweepRuntime {
  /** The persisted unbounded-window aliases (`unboundedWindowKeys()`). */
  aliasKeys: readonly string[];
  /** A30's parse alone (`validatePersistedValue`). */
  validate: (key: string, value: unknown) => PersistedValueCheck;
}

/**
 * A30 before readiness: clear every usable alias row whose value does not
 * parse as its entry's payload (a row schema that moved in a way the L2
 * definition does not fingerprint). Called in `onReadyBlocking`, so
 * boot-snapshot's persisted fast path — open from readiness, while `onReady`'s
 * seed has not yet put a kept snapshot in front of the row — never serves a
 * value the client's hydrate would reject. `runBootCatchUp` then finds no row
 * for the key and recomputes it; its own `invalid` branch stays the backstop.
 * Returns each cleared key with the parse error.
 */
export async function clearInvalidAliasSnapshots(
  db: NodePgDatabase,
  exp: L2Expectation,
  rt: InvalidAliasSweepRuntime,
): Promise<Array<{ key: string; error: string }>> {
  const persisted = new Set(exp.persisted);
  const keys = rt.aliasKeys.filter((k) => persisted.has(k));
  if (keys.length === 0) return [];
  const rows = await readPersistedSnapshots(db, keys, exp);
  const invalid: Array<{ key: string; error: string }> = [];
  for (const [key, row] of rows) {
    const check = rt.validate(key, row.value);
    if (check.kind === "invalid") invalid.push({ key, error: check.error });
  }
  await clearPersistedSnapshots(
    db,
    invalid.map((i) => i.key),
  );
  return invalid;
}

/**
 * The L2 boot sequence `onReady` runs (§4.2 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md). Every read
 * applies the usable-row predicate (`exp`), and catch-up is PROBED before
 * anything is seeded — a backstop must clear and recompute, never seed a diff
 * base from a row it cannot prove current:
 *
 *  0. a rollup the boot reconcile healed → the backstop below (the rows were
 *     already cleared in `onReadyBlocking`; cleared again here, since a
 *     previous backend may still have persisted one in between);
 *  1. the usable rows' read-sets;
 *  2. `probeCatchUp`;
 *  3. backstop → clear the persisted rows, recompute every persisted key, stop;
 *  4. otherwise recompute each key with no usable read-set, seed each alias
 *     (its base floor = its row's position) — an alias whose value does not
 *     parse as its payload (A30) is treated as missing: its row is cleared and
 *     the key recomputed —, then replay from the LOWER of the probe's floor and
 *     every seeded row's position.
 *
 * Returns the probe's verdict, for the caller's log and the tests.
 */
export async function runBootCatchUp(
  db: NodePgDatabase,
  exp: L2Expectation,
  rt: BootCatchUpRuntime,
): Promise<"none" | "backstop" | "replay"> {
  // 0. A healed rollup: its rows changed at boot with nothing in the changelog
  // to replay (a rollup is feed-exempt), so every persisted value is suspect —
  // a reader may reach it through a view. Same as the backstop. Rare: a clean
  // boot's reconcile heals nothing (D21).
  if (rt.healedRollups.length > 0) {
    log.publish(
      `[live-state-snapshot] WARNING: the boot reconcile healed rollup(s) ${rt.healedRollups.join(", ")} — no persisted value can be proven current; clearing the persisted rows and recomputing all ${exp.persisted.length} persisted key(s)`,
      "stderr",
    );
    await clearHealedSnapshots(db, exp, rt.healedRollups);
    for (const key of exp.persisted) rt.recompute(key);
    return "backstop";
  }

  // 1. The usable rows' read-sets.
  const usable = await readPersistedReadSets(db, exp);
  // 2. What catch-up will do.
  const probe = await probeCatchUp(db, exp);

  // 3. Backstop: history was pruned past the oldest usable row's floor, so no
  // row can be proven current. Clear them (the boot snapshot then loads from
  // scratch rather than serve one) and FULL-recompute every persisted key —
  // each re-persists with a fresh floor. Nothing is seeded or replayed.
  if (probe.kind === "backstop") {
    log.publish(
      `[live-state-snapshot] WARNING: the changelog was pruned through xid ${probe.horizon} ≥ snapshot floor ${probe.floor} — history pruned past a stale snapshot; clearing the persisted rows and recomputing all ${exp.persisted.length} persisted key(s)`,
      "stderr",
    );
    await clearPersistedSnapshots(db, [...exp.persisted]);
    for (const key of exp.persisted) rt.recompute(key);
    return "backstop";
  }

  // 4a. FULL-recompute each persisted key with NO usable read-set (first boot,
  // a newly-persisted resource, a changed definition, an older writer's row, an
  // empty read-set): catch-up cannot bound it. The recompute persists its value
  // AND read-set for the next boot.
  //
  // `floors` — each key's own replay floor (`ReplayScope`): its usable row's
  // position, lowered to its seeded row's below; a key recomputed here is
  // dropped from it, so the replay routes every row to it as before.
  const floors =
    probe.kind === "replay"
      ? new Map(probe.positions)
      : new Map<string, string>();
  const recompute = (key: string): void => {
    floors.delete(key);
    rt.recompute(key);
  };
  const aliases = new Set(rt.aliasKeys);
  const seedKeys: string[] = [];
  for (const key of exp.persisted) {
    if (!usable.get(key)?.length) {
      recompute(key);
      continue;
    }
    if (aliases.has(key)) seedKeys.push(key);
  }

  // 4b. Restore each persisted alias's in-memory diff base — and its base
  // floor, the row's position — from its usable L2 row BEFORE catch-up, so the
  // first post-boot change (and every downtime change the catch-up replays) is
  // a scoped refill instead of a FULL O(collection) rebuild. All L2 rows are
  // param-less ("{}"); jsonb comes back already parsed.
  //
  // The seed rows are read AFTER the probe, in another statement — and during a
  // hot swap the previous backend may still floor-persist meanwhile, LOWERING a
  // row's position below the probe's floor. So the replay floor is the lowest
  // of the probe's and every seeded position (a commit in between would
  // otherwise never be replayed for that alias), and a seeded row whose
  // position the changelog was pruned past is recomputed instead of seeded,
  // exactly as the backstop treats it.
  let replayFloor = probe.kind === "replay" ? probe.floor : undefined;
  if (seedKeys.length > 0) {
    const rows = await readPersistedSnapshots(db, seedKeys, exp);
    // Read after the rows, never the probe's: a prune since the probe would
    // make that one too old to judge them by.
    const horizon = rows.size === 0 ? null : await readPruneHorizon(db);
    for (const [key, row] of rows) {
      if (isPrunedPast(row.position, horizon)) {
        recompute(key);
        continue;
      }
      const seeded = rt.seed(key, row.value, {
        position: row.position,
        positionAt: row.positionAt,
      });
      if (seeded.kind === "invalid") {
        // A30 backstop (`clearInvalidAliasSnapshots` already cleared such rows
        // before readiness): a value the entry could not have produced is no
        // diff base, and no first paint either — cleared, so boot-snapshot
        // stops serving it, and recomputed as a missing row would be.
        log.publish(
          `[live-state-snapshot] WARNING: the persisted value of "${key}" does not parse as its payload (${seeded.error}) — clearing its row and recomputing it`,
          "stderr",
        );
        await clearPersistedSnapshots(db, [key]);
        recompute(key);
        continue;
      }
      // The seeded snapshot stands on THIS row's position; a row the previous
      // backend lowered since the probe lowers the key's floor with it.
      const probed = floors.get(key);
      floors.set(
        key,
        probed === undefined ? row.position : minPosition(probed, row.position),
      );
      replayFloor =
        replayFloor === undefined
          ? row.position
          : minPosition(replayFloor, row.position);
    }
  }

  // 4c. Replay from the lowest floor anything seeded or probed stands on.
  if (replayFloor !== undefined) {
    // A hot swap's previous backend may have rewritten a NON-alias row since
    // the probe — a replace from an older flight leaves a lower position, and
    // boot-snapshot may serve that row. Re-read every key still holding a
    // floor and keep the lower position, as the seed read does for aliases:
    // a key's floor is only ever the lowest this boot read for it.
    // The replay floor follows it (a lowered row's commits must be READ, not
    // only routed), and a row lowered past the prune horizon is recomputed,
    // exactly as a seeded alias's is.
    const reread = await readUsablePositions(db, exp);
    const reHorizon = reread.size === 0 ? null : await readPruneHorizon(db);
    for (const [key, position] of reread) {
      const held = floors.get(key);
      if (held === undefined || BigInt(position) >= BigInt(held)) continue;
      if (isPrunedPast(position, reHorizon)) {
        recompute(key);
        continue;
      }
      floors.set(key, position);
      replayFloor = minPosition(replayFloor, position);
    }
    await replayCatchUp(db, replayFloor, floors, rt.route);
  }
  return probe.kind;
}
