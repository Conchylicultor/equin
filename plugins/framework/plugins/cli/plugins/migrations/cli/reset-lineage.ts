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
 *
 * A reset can also regenerate NOTHING: the branch's delta already landed on
 * main through someone else's published migration (a different hash). Those
 * published files then redo, in a database that applied the deleted ones, DDL
 * that is already there. `resetAdoption` finds the run of published migrations
 * whose combined delta is the deleted one, and the reset writes an adoption
 * file naming them (research/2026-10-21-global-reset-adopts-published-migration.md).
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  analyzeSnapshotDag,
  equivalentSnapshots,
  mergeSnapshots,
  parseMigration,
  readSnapshotNodes,
  type Snapshot,
  snapshotAncestors,
  type SnapshotBodies,
  type SnapshotNode,
  type Supersession,
} from "@plugins/database/plugins/migrations/core";

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

/**
 * Read what a reset of `migrationsDir` will delete: every branch-local (not
 * `published`) schema migration — a NEW_FORMAT node of the snapshot DAG, the
 * same set `resetBranchLocalMigrations` removes — with its hash, its own
 * lineage, and the schema the set ends at (its tip's body, from `bodies`).
 * Call BEFORE the reset.
 */
export async function readResetPrior(
  migrationsDir: string,
  published: ReadonlySet<string>,
  bodies: SnapshotBodies,
): Promise<ResetPrior> {
  const deleted: DeletedMigration[] = [];
  const own = new Map<string, SnapshotNode>();
  let mergeNode: string | null = null;
  const nodes = (await readSnapshotNodes(migrationsDir)).sort((a, b) =>
    a.file.localeCompare(b.file),
  );
  for (const n of nodes) {
    const m = NEW_FORMAT.exec(n.file);
    if (!m || published.has(n.file)) continue;
    const parsed = parseMigration(
      readFileSync(join(migrationsDir, n.file), "utf8"),
    );
    own.set(n.id, n);
    if (n.mergeParents !== null) mergeNode = n.file;
    deleted.push({
      file: n.file,
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

  const referenced = new Set([...own.values()].map((n) => n.prevId));
  const tips = [...own.keys()].filter((id) => !referenced.has(id));
  if (tips.length !== 1)
    return {
      deleted,
      schema: {
        kind: "unknown",
        reason: `the branch's own snapshots end in ${tips.length} tips, not one`,
      },
    };
  let at = own.get(tips[0]!)!;
  const seen = new Set<string>();
  while (own.has(at.prevId)) {
    if (seen.has(at.id))
      throw new Error(`branch-local snapshot chain loops at ${at.id}`);
    seen.add(at.id);
    at = own.get(at.prevId)!;
  }
  return {
    deleted,
    schema: {
      kind: "known",
      tip: (await bodies.body(tips[0]!)) as Snapshot,
      baseId: at.prevId,
    },
  };
}

/** The lineage a regenerated migration records, or why it records none. */
export type ResetLineage =
  | { kind: "supersedes"; supersedes: Supersession }
  | { kind: "none"; reason: string | null };

/**
 * The `supersedes` header for the migration this reset just generated (its
 * snapshot `fresh`, as drizzle-kit emitted it), from what the reset deleted
 * (`prior`).
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
  fresh: Snapshot,
  bodies: SnapshotBodies,
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

  const nodes = await readSnapshotNodes(migrationsDir);
  const isNode = (id: string) => nodes.some((n) => n.id === id);
  if (!isNode(prior.schema.baseId) || !isNode(fresh.prevId as string))
    return {
      kind: "none",
      reason: `the snapshot the branch forked from (${prior.schema.baseId}) or the one the new migration diffs against (${String(fresh.prevId)}) is not a migration on disk`,
    };
  const merged = mergeSnapshots(
    (await bodies.body(prior.schema.baseId)) as Snapshot,
    prior.schema.tip,
    (await bodies.body(fresh.prevId as string)) as Snapshot,
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

  return { kind: "supersedes", supersedes: lineageOf(gone) };
}

// The lineage that replaces `gone`: their hashes, plus each one's own lineage
// passed on as inherited edges (a regen of a regen still reaches what a
// database actually applied).
function lineageOf(gone: readonly DeletedMigration[]): Supersession {
  const inherited = new Map<string, readonly string[]>();
  for (const d of gone) {
    if (d.supersedes === null) continue;
    inherited.set(d.hash, d.supersedes.direct);
    for (const e of d.supersedes.inherited) inherited.set(e.hash, e.replaced);
  }
  return {
    direct: gone.map((d) => d.hash),
    inherited: [...inherited].map(([hash, replaced]) => ({
      hash,
      replaced,
    })),
  };
}

/** The published files a reset that regenerated nothing adopts, or why none. */
export type ResetAdoption =
  | {
      kind: "adopts";
      /** The adopted files, in timestamp order, and their hashes. */
      files: readonly string[];
      adopts: readonly string[];
      supersedes: Supersession;
    }
  | { kind: "none"; reason: string | null };

/**
 * For a reset that regenerated no schema migration: the contiguous run of
 * published schema migrations `p_i … p_j` whose combined delta is the deleted
 * migrations' — the branch's delta replayed (3-way merge) onto the snapshot
 * before `p_i` equals the snapshot after `p_j`, and is not already in it.
 *
 * Adopting that run (recording it without its DDL) and applying every other
 * published migration in order is what main did: a migration before the run
 * never created the delta's objects (`p_i` would have failed on main), and one
 * after it ran on main with them already there.
 *
 * Call after the reset and the tip join, so every snapshot on disk is
 * published. `reason` is null when there is nothing to account for (nothing
 * deleted, or the deleted migrations changed nothing); otherwise it says why
 * no run qualifies — the caller warns, since a database that applied the
 * deleted migrations may then fail to apply main's.
 */
export async function resetAdoption(
  migrationsDir: string,
  prior: ResetPrior,
  bodies: SnapshotBodies,
): Promise<ResetAdoption> {
  if (prior.deleted.length === 0) return { kind: "none", reason: null };
  if (prior.schema.kind === "unknown")
    return { kind: "none", reason: prior.schema.reason };
  const { tip: ours, baseId } = prior.schema;

  const nodes = await readSnapshotNodes(migrationsDir);
  const dag = analyzeSnapshotDag(nodes);
  const baseNode = dag.byId.get(baseId);
  if (baseNode === undefined)
    return {
      kind: "none",
      reason: `the snapshot the branch forked from (${baseId}) is not on disk`,
    };
  // Bodies come from the working tree or git (`bodies` caches them).
  const load = async (n: SnapshotNode): Promise<Snapshot> =>
    (await bodies.body(n.id)) as Snapshot;
  const base = await load(baseNode);
  if (equivalentSnapshots(base, ours)) return { kind: "none", reason: null };

  // A node a run may hold: a phased schema migration (the runner adopts no
  // other kind), not a merge node, published after the fork.
  const onDisk = new Set(readdirSync(migrationsDir));
  const runnableHash = (n: SnapshotNode): string | null => {
    if (n.mergeParents !== null) return null;
    const m = NEW_FORMAT.exec(n.file);
    if (!m) return null;
    if (!onDisk.has(n.file)) return null;
    const parsed = parseMigration(
      readFileSync(join(migrationsDir, n.file), "utf8"),
    );
    if (parsed.kind !== "phased" || parsed.adopts.length > 0) return null;
    return m[3]!;
  };
  const hashes = new Map<string, string | null>();
  const hashOf = (n: SnapshotNode): string | null => {
    if (!hashes.has(n.id)) hashes.set(n.id, runnableHash(n));
    return hashes.get(n.id)!;
  };
  const forked = new Map<string, boolean>();
  const afterFork = (n: SnapshotNode): boolean => {
    if (!forked.has(n.id))
      forked.set(
        n.id,
        n.id !== baseId && snapshotAncestors(dag, n.id).has(baseId),
      );
    return forked.get(n.id)!;
  };

  // The branch's delta replayed onto a snapshot, per snapshot id.
  const replayed = new Map<string, Snapshot | null>();
  const replayOnto = async (prev: SnapshotNode): Promise<Snapshot | null> => {
    if (!replayed.has(prev.id)) {
      const prevBody = await load(prev);
      const r = mergeSnapshots(base, ours, prevBody);
      replayed.set(
        prev.id,
        r.ok && !equivalentSnapshots(r.merged, prevBody) ? r.merged : null,
      );
    }
    return replayed.get(prev.id)!;
  };

  // Shortest run first, then earliest end: a run that matches is the smallest
  // set of files the deleted delta stands for.
  const candidates: SnapshotNode[][] = [];
  for (const end of [...nodes].sort((a, b) => a.file.localeCompare(b.file))) {
    if (!afterFork(end) || hashOf(end) === null) continue;
    const run: SnapshotNode[] = [];
    let at: SnapshotNode | undefined = end;
    while (at !== undefined && afterFork(at) && hashOf(at) !== null) {
      run.unshift(at);
      const prev = dag.byId.get(at.prevId);
      if (prev === undefined) break;
      const merged = await replayOnto(prev);
      if (merged !== null && equivalentSnapshots(merged, await load(end)))
        candidates.push([...run]);
      at = prev;
    }
  }
  if (candidates.length === 0)
    return {
      kind: "none",
      reason:
        "no run of main's migrations since the branch forked makes exactly the deleted migrations' change (main's does more, splits it, or the branch's schema change was reverted)",
    };
  candidates.sort((a, b) => a.length - b.length);
  const chosen = candidates[0]!;
  const files = chosen.map((n) => n.file);
  return {
    kind: "adopts",
    files,
    adopts: chosen.map((n) => hashOf(n)!),
    supersedes: lineageOf(prior.deleted),
  };
}
