/**
 * Keeping `data/meta/` in its one shape
 * (research/2026-10-22-global-single-live-migration-snapshot.md §1, §7):
 * `schema.snapshot.json` is the DAG tip's body, `legacy-snapshots.json` holds
 * the lineage of every pre-cutover schema migration, and no per-migration
 * `<tag>_snapshot.json` is left.
 *
 * `settleSnapshotFiles` runs on every generate, after the reset and the tip
 * join and before drizzle-kit is staged. On a tree already in shape it writes
 * nothing. Otherwise it is the CUTOVER — once in the branch that introduced the
 * shape, and once more in any clone that merges it while holding legacy schema
 * migrations of its own: their `{ id, prevId }` are folded into
 * `legacy-snapshots.json`, the tip body is written, and the per-migration
 * files are deleted.
 */
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  analyzeSnapshotDag,
  legacySnapshotFiles,
  legacySnapshotsPath,
  readLegacySnapshots,
  readSnapshotHead,
  readSnapshotNodes,
  renderLegacySnapshots,
  schemaSnapshotPath,
  type SnapshotBodies,
} from "@plugins/database/plugins/migrations/core";

/** What `settleSnapshotFiles` changed. */
export interface SettledSnapshotFiles {
  /** The tip id `schema.snapshot.json` was (re)written to, or null when it already was the tip. */
  wroteTip: string | null;
  /** The legacy `<tag>_snapshot.json` files folded into `legacy-snapshots.json` and deleted. */
  folded: string[];
}

/**
 * Bring `data/meta/` into shape (see the module docblock). Throws, writing
 * nothing more, when a legacy file disagrees with the entry already recorded
 * for its tag — two lineages for one migration is corruption, not something to
 * pick a side of.
 */
export async function settleSnapshotFiles(
  migrationsDir: string,
  bodies: SnapshotBodies,
): Promise<SettledSnapshotFiles> {
  // The tip body first, while every legacy body is still on disk to copy from.
  let wroteTip: string | null = null;
  const dag = analyzeSnapshotDag(await readSnapshotNodes(migrationsDir));
  if (dag.tips.length === 1) {
    const tip = dag.tips[0]!;
    const path = schemaSnapshotPath(migrationsDir);
    if (readSnapshotHead(path)?.id !== tip.id) {
      writeFileSync(path, await bodies.text(tip.id));
      wroteTip = tip.id;
    }
  }

  const files = legacySnapshotFiles(migrationsDir);
  const recorded = readLegacySnapshots(migrationsDir);
  if (files.length === 0 && recorded !== null) return { wroteTip, folded: [] };

  const entries = new Map(recorded ?? []);
  for (const file of files) {
    const tag = file.slice(0, -"_snapshot.json".length);
    const head = readSnapshotHead(join(migrationsDir, "meta", file))!;
    const prior = entries.get(tag);
    if (
      prior !== undefined &&
      (prior.id !== head.id || prior.prevId !== head.prevId)
    )
      throw new Error(
        `meta/${file} is snapshot ${head.id} (prevId ${head.prevId}), but meta/legacy-snapshots.json records ${tag} as ${prior.id} (prevId ${prior.prevId}). ` +
          "Two lineages for one migration: restore both files from git and report it.",
      );
    entries.set(tag, head);
  }
  writeFileSync(
    legacySnapshotsPath(migrationsDir),
    renderLegacySnapshots(entries),
  );
  for (const file of files) rmSync(join(migrationsDir, "meta", file));
  return { wroteTip, folded: files };
}

/**
 * Drop `tags` from `legacy-snapshots.json` — the entries of BRANCH-LOCAL
 * schema migrations a reset deletes (a branch from before the cutover, folded
 * by it). A published entry is never passed here: the reset only deletes what
 * is not published, and `published-migrations-immutable` pins the rest.
 */
export function dropLegacyEntries(
  migrationsDir: string,
  tags: readonly string[],
): void {
  const recorded = readLegacySnapshots(migrationsDir);
  if (recorded === null || !tags.some((t) => recorded.has(t))) return;
  for (const t of tags) recorded.delete(t);
  writeFileSync(
    legacySnapshotsPath(migrationsDir),
    renderLegacySnapshots(recorded),
  );
}
