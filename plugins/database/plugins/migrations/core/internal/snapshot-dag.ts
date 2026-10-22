/**
 * The drizzle snapshot DAG — one definition of its edges, read by the CLI's
 * generate pipeline (which joins tips with a merge node and stages drizzle-kit's
 * view of it) and by the `snapshot-chain-intact` / `migrations-in-sync` checks.
 *
 * Every schema migration is one node, identified by its `.sql` basename. Its
 * lineage comes from the `.sql`'s snapshot header (`snapshotLineage`,
 * `./phases`) or, for a migration from before the snapshot cutover, from
 * `meta/legacy-snapshots.json` (or a not-yet-folded `meta/<tag>_snapshot.json`)
 * — see `./schema-snapshot`. No snapshot BODY is read here. A node's parent is
 * its `prevId`, except a MERGE NODE's, whose parents are all the ids its header
 * names. A healthy history is a DAG with exactly one root and exactly one tip:
 * a checkout that merged another `main` (an upstream update) forks at the merge
 * base and re-joins at the merge node. See
 * research/2026-09-30-global-clone-migrations-published-set.md §3 and
 * research/2026-10-22-global-single-live-migration-snapshot.md.
 */
import { readdirSync } from "fs";
import { join } from "path";
import {
  legacySnapshotFiles,
  legacySnapshotSql,
  readLegacySnapshots,
  readSnapshotHead,
  readSnapshotLineage,
  SCHEMA_SNAPSHOT_FILE,
  schemaSnapshotPath,
} from "./schema-snapshot";

/** drizzle's `prevId` of the first snapshot. */
export const NULL_SNAPSHOT_ID = "00000000-0000-0000-0000-000000000000";

/** One snapshot, as far as the DAG is concerned. */
export interface SnapshotNode {
  /** The schema migration's `.sql` basename. */
  file: string;
  id: string;
  /** drizzle's single parent: a merge node's parent that sorts last. */
  prevId: string;
  /** Every parent, when the migration is a merge node. */
  mergeParents: readonly string[] | null;
  /**
   * Where its lineage is recorded: its own `.sql` header, or (written before
   * the snapshot cutover) `legacy-snapshots.json` / a `<tag>_snapshot.json`.
   * Says where its BODY lives in git (`./snapshot-bodies`).
   */
  lineage: "header" | "legacy";
}

/** Why a set of snapshots is not a single-root, single-tip DAG. */
export type SnapshotDagProblem =
  | { kind: "duplicate-id"; id: string; files: string[] }
  | { kind: "missing-parent"; file: string; parent: string }
  | { kind: "merge-prev-not-parent"; file: string }
  | { kind: "no-root" }
  | { kind: "multiple-roots"; files: string[] }
  | { kind: "cycle"; files: string[] }
  | { kind: "unreachable"; files: string[] }
  | { kind: "multiple-tips"; files: string[] };

export interface SnapshotDag {
  byId: ReadonlyMap<string, SnapshotNode>;
  /** Parent ids of a node (only those present). */
  parentsOf(id: string): readonly string[];
  roots: readonly SnapshotNode[];
  /** Nodes no other node names as a parent, in file order. */
  tips: readonly SnapshotNode[];
  /** Every structural problem, `multiple-tips` included. */
  problems: readonly SnapshotDagProblem[];
}

/** A node's declared parent ids: the merge header's, else its `prevId`. */
export function declaredParents(n: SnapshotNode): readonly string[] {
  if (n.mergeParents) return n.mergeParents;
  return n.prevId === NULL_SNAPSHOT_ID ? [] : [n.prevId];
}

/** PURE: the DAG over `nodes`, and everything wrong with it. */
export function analyzeSnapshotDag(
  nodes: readonly SnapshotNode[],
): SnapshotDag {
  const sorted = [...nodes].sort((a, b) => a.file.localeCompare(b.file));
  const problems: SnapshotDagProblem[] = [];

  const byId = new Map<string, SnapshotNode>();
  const dupes = new Map<string, string[]>();
  for (const n of sorted) {
    const prior = byId.get(n.id);
    if (prior) {
      const files = dupes.get(n.id) ?? [prior.file];
      files.push(n.file);
      dupes.set(n.id, files);
      continue;
    }
    byId.set(n.id, n);
  }
  for (const [id, files] of dupes)
    problems.push({ kind: "duplicate-id", id, files });

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const n of byId.values()) {
    if (n.mergeParents && !n.mergeParents.includes(n.prevId))
      problems.push({ kind: "merge-prev-not-parent", file: n.file });
    const present: string[] = [];
    for (const p of declaredParents(n)) {
      if (!byId.has(p)) {
        problems.push({ kind: "missing-parent", file: n.file, parent: p });
        continue;
      }
      if (present.includes(p)) continue;
      present.push(p);
      const list = children.get(p) ?? [];
      list.push(n.id);
      children.set(p, list);
    }
    parents.set(n.id, present);
  }

  const all = [...byId.values()];
  const roots = all.filter((n) => declaredParents(n).length === 0);
  const tips = all.filter((n) => !children.has(n.id));
  if (all.length > 0 && roots.length === 0) problems.push({ kind: "no-root" });
  if (roots.length > 1)
    problems.push({ kind: "multiple-roots", files: roots.map((r) => r.file) });

  // Kahn's order: whatever it cannot reach sits on (or behind) a cycle.
  const indegree = new Map(all.map((n) => [n.id, parents.get(n.id)!.length]));
  const queue = all.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const ordered = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.add(id);
    for (const c of children.get(id) ?? []) {
      const d = indegree.get(c)! - 1;
      indegree.set(c, d);
      if (d === 0) queue.push(c);
    }
  }
  const cyclic = all.filter((n) => !ordered.has(n.id));
  if (cyclic.length > 0)
    problems.push({ kind: "cycle", files: cyclic.map((n) => n.file) });

  // With one root, every node must descend from it. (Several roots are
  // already a problem of their own; reachability from each adds nothing.)
  if (roots.length === 1 && cyclic.length === 0) {
    const reached = new Set<string>([roots[0]!.id]);
    const stack = [roots[0]!.id];
    while (stack.length > 0) {
      for (const c of children.get(stack.pop()!) ?? []) {
        if (reached.has(c)) continue;
        reached.add(c);
        stack.push(c);
      }
    }
    const unreachable = all.filter((n) => !reached.has(n.id));
    if (unreachable.length > 0)
      problems.push({
        kind: "unreachable",
        files: unreachable.map((n) => n.file),
      });
  }

  // In a finite acyclic graph every node reaches some tip, so one tip means
  // every node reaches it.
  if (tips.length > 1)
    problems.push({ kind: "multiple-tips", files: tips.map((t) => t.file) });

  return {
    byId,
    parentsOf: (id) => parents.get(id) ?? [],
    roots,
    tips,
    problems,
  };
}

/** PURE: `id` and every node it descends from. */
export function snapshotAncestors(dag: SnapshotDag, id: string): Set<string> {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const p of dag.parentsOf(stack.pop()!)) {
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(p);
    }
  }
  return seen;
}

/**
 * Every schema migration under `dataDir` as a DAG node: one per `.sql` with a
 * snapshot header, one per `legacy-snapshots.json` entry, and one per
 * not-yet-folded `meta/<tag>_snapshot.json` whose tag is not already a legacy
 * key. Only the start of each file is read. A legacy entry whose `.sql` is gone
 * is still a node (`migration-metadata-consistent` owns that orphan).
 */
export async function readSnapshotNodes(
  dataDir: string,
): Promise<SnapshotNode[]> {
  const nodes: SnapshotNode[] = [];
  const legacy = readLegacySnapshots(dataDir);
  for (const [tag, head] of legacy ?? []) {
    nodes.push({
      file: `${tag}.sql`,
      ...head,
      mergeParents: null,
      lineage: "legacy",
    });
  }
  for (const file of legacySnapshotFiles(dataDir)) {
    const sql = legacySnapshotSql(file);
    if (legacy?.has(sql.slice(0, -".sql".length))) continue;
    const head = readSnapshotHead(join(dataDir, "meta", file))!;
    nodes.push({ file: sql, ...head, mergeParents: null, lineage: "legacy" });
  }
  for (const file of readdirSync(dataDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const lineage = readSnapshotLineage(dataDir, file);
    if (lineage === null) continue;
    nodes.push({
      file,
      id: lineage.id,
      prevId: lineage.parents[lineage.parents.length - 1]!,
      mergeParents: lineage.parents.length > 1 ? lineage.parents : null,
      lineage: "header",
    });
  }
  return nodes;
}

/** Whether `schema.snapshot.json` is the body of the DAG's single tip. */
export type SchemaSnapshotState = { ok: true } | { ok: false; message: string };

/**
 * The invariant every drizzle-kit run rests on: `meta/schema.snapshot.json` is
 * the body of the DAG's single tip — its `id` is the tip's id (and it exists
 * whenever the DAG has a node). Not judged on a multi-tip DAG: that is its own
 * problem (`analyzeSnapshotDag`), and the join rewrites the file anyway.
 */
export function schemaSnapshotState(
  dataDir: string,
  dag: SnapshotDag,
): SchemaSnapshotState {
  if (dag.tips.length !== 1) return { ok: true };
  const tip = dag.tips[0]!;
  const head = readSnapshotHead(schemaSnapshotPath(dataDir));
  if (head === null)
    return {
      ok: false,
      message: `meta/${SCHEMA_SNAPSHOT_FILE} is missing; the snapshot DAG's tip is ${tip.file} (${tip.id}).`,
    };
  if (head.id !== tip.id)
    return {
      ok: false,
      message: `meta/${SCHEMA_SNAPSHOT_FILE} is snapshot ${head.id}, but the snapshot DAG's tip is ${tip.file} (${tip.id}).`,
    };
  return { ok: true };
}
