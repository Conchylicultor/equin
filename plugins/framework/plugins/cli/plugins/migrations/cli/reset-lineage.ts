/**
 * What a reset (`--reset-migration`, push's `regen-migrations`) replaces, and
 * whether the migration it regenerates may say so — the generator half of
 * supersession (research/2026-10-20-global-merged-migration-supersedes-authored.md).
 *
 * A reset deletes the branch's own schema migrations and drizzle re-emits their
 * delta as one new file with a new hash. A database that applied the deleted
 * files (this worktree's, which built them) already carries that delta, and
 * the runner's ledger is keyed by hash. The new file's `supersedes` header
 * names the deleted hashes so the runner ADOPTS it there instead of re-running
 * DDL that is already applied.
 *
 * Adopting skips the new file's SQL, so the header is written only when that
 * is provably the same schema: the deleted migrations' tip snapshot, carried
 * over whatever the published tip changed since the branch forked (the 3-way
 * merge a merge node uses), must equal the snapshot drizzle just generated.
 * They differ when schema.ts changed after the last generation (the new file
 * then holds DDL the deleted ones never did) — no header, and the runner
 * applies the file as before.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  mergeSnapshotParents,
  parseMigration,
  readSnapshotNodes,
  type Supersession,
} from "@plugins/database/plugins/migrations/core";
import {
  equivalentSnapshots,
  mergeSnapshots,
  type Snapshot,
} from "./snapshot-merge";

const NEW_FORMAT = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

/** One branch-local schema migration the reset is about to delete. */
export interface DeletedMigration {
  file: string;
  hash: string;
  supersedes: Supersession | null;
}

/** What the reset deletes, read before it does. */
export interface ResetPrior {
  deleted: DeletedMigration[];
  /**
   * The schema the deleted migrations leave a database in: their tip snapshot
   * and the published snapshot their chain grew from — or why there is no
   * single such schema to state.
   */
  schema:
    | { kind: "known"; tip: Snapshot; baseId: string }
    | { kind: "unknown"; reason: string };
}

function readSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

/**
 * Read what a reset of `migrationsDir` will delete: every branch-local (not
 * `published`) schema migration — a NEW_FORMAT `.sql` with a sibling snapshot,
 * the same set `resetBranchLocalMigrations` removes — with its hash, its own
 * lineage, and the schema the set ends at. Call BEFORE the reset.
 */
export function readResetPrior(
  migrationsDir: string,
  published: ReadonlySet<string>,
): ResetPrior {
  const metaDir = join(migrationsDir, "meta");
  const deleted: DeletedMigration[] = [];
  const snapshots = new Map<string, Snapshot>();
  let mergeNode: string | null = null;
  for (const f of readdirSync(migrationsDir).sort()) {
    const m = NEW_FORMAT.exec(f);
    if (!m || published.has(f)) continue;
    const snapPath = join(metaDir, `${f.slice(0, -4)}_snapshot.json`);
    if (!existsSync(snapPath)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const parsed = parseMigration(sql);
    const snap = readSnapshot(snapPath);
    if (typeof snap.id !== "string" || typeof snap.prevId !== "string")
      throw new Error(`${snapPath} has no string id / prevId`);
    snapshots.set(snap.id, snap);
    if (mergeSnapshotParents(sql) !== null) mergeNode = f;
    deleted.push({
      file: f,
      hash: m[3]!,
      supersedes: parsed.kind === "phased" ? parsed.supersedes : null,
    });
  }
  if (deleted.length === 0)
    return { deleted, schema: { kind: "unknown", reason: "nothing to reset" } };
  if (mergeNode !== null)
    return {
      deleted,
      schema: {
        kind: "unknown",
        reason: `the branch carries the merge node ${mergeNode}, whose schema is not one chain from a published snapshot`,
      },
    };

  const referenced = new Set(
    [...snapshots.values()].map((s) => s.prevId as string),
  );
  const tips = [...snapshots.keys()].filter((id) => !referenced.has(id));
  if (tips.length !== 1)
    return {
      deleted,
      schema: {
        kind: "unknown",
        reason: `the branch's own snapshots end in ${tips.length} tips, not one`,
      },
    };
  const tip = snapshots.get(tips[0]!)!;
  let at = tip;
  const seen = new Set<string>();
  while (snapshots.has(at.prevId as string)) {
    if (seen.has(at.id as string))
      throw new Error(`branch-local snapshot chain loops at ${String(at.id)}`);
    seen.add(at.id as string);
    at = snapshots.get(at.prevId as string)!;
  }
  return {
    deleted,
    schema: { kind: "known", tip, baseId: at.prevId as string },
  };
}

/** The lineage a regenerated migration records, or why it records none. */
export type ResetLineage =
  | { kind: "supersedes"; supersedes: Supersession }
  | { kind: "none"; reason: string | null };

/**
 * The `supersedes` header for the migration this reset just generated (its
 * snapshot at `freshSnapshotPath`), from what the reset deleted (`prior`).
 *
 * A deleted hash back on disk is not superseded — the reset wrote the same
 * bytes again (a merge node is regenerated byte-identical). `reason` is null
 * when there is nothing to supersede, and otherwise says why the header was
 * withheld: the caller prints it, since a database that applied the deleted
 * migrations will then fail to apply the new one.
 */
export async function resetLineage(
  migrationsDir: string,
  prior: ResetPrior,
  freshSnapshotPath: string,
): Promise<ResetLineage> {
  const onDisk = new Set(
    readdirSync(migrationsDir)
      .map((f) => NEW_FORMAT.exec(f)?.[3])
      .filter((h): h is string => h !== undefined),
  );
  const gone = prior.deleted.filter((d) => !onDisk.has(d.hash));
  if (gone.length === 0) return { kind: "none", reason: null };
  if (prior.schema.kind === "unknown")
    return { kind: "none", reason: prior.schema.reason };

  const fresh = readSnapshot(freshSnapshotPath);
  const nodes = await readSnapshotNodes(migrationsDir);
  const pathOf = (id: string): string | null => {
    const node = nodes.find((n) => n.id === id);
    return node ? join(migrationsDir, "meta", node.file) : null;
  };
  const basePath = pathOf(prior.schema.baseId);
  const theirsPath = pathOf(fresh.prevId as string);
  if (basePath === null || theirsPath === null)
    return {
      kind: "none",
      reason: `the snapshot the branch forked from (${prior.schema.baseId}) or the one the new migration diffs against (${String(fresh.prevId)}) is not on disk`,
    };
  const merged = mergeSnapshots(
    readSnapshot(basePath),
    prior.schema.tip,
    readSnapshot(theirsPath),
  );
  if (!merged.ok)
    return {
      kind: "none",
      reason:
        "the branch's own schema conflicts with what main changed since it forked",
    };
  if (!equivalentSnapshots(merged.merged, fresh))
    return {
      kind: "none",
      reason:
        "the regenerated schema differs from what the deleted migrations applied (schema.ts changed after their last generation)",
    };

  const inherited = new Map<string, readonly string[]>();
  for (const d of gone) {
    if (d.supersedes === null) continue;
    inherited.set(d.hash, d.supersedes.direct);
    for (const e of d.supersedes.inherited) inherited.set(e.hash, e.replaced);
  }
  return {
    kind: "supersedes",
    supersedes: {
      direct: gone.map((d) => d.hash),
      inherited: [...inherited].map(([hash, replaced]) => ({
        hash,
        replaced,
      })),
    },
  };
}
