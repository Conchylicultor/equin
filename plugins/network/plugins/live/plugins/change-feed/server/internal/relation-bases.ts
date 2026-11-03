import { setRelationBases } from "@plugins/framework/plugins/server-core/core";

// Relation bases (C30 of research/2026-10-06-global-scoped-change-routing-p8-v3.md):
// the base tables a read of a relation depends on — the relations a write to
// which can change what the read returns.
//
//  - A base table is its own base.
//  - A view's bases are the union of the bases of every relation it reads
//    (`view_table_usage`, views-on-views followed transitively).
//  - A rollup (derived-tables) carries no trigger: a write to it is always
//    caused by a write to one of its sources, so its bases are its sources'.
//
// The bases are always base tables: a view or rollup is never its own base (no
// change is ever routed under its name), so `relationBases("agents_v")` is
// `["agents"]` and a base table's is itself.
//
// The graph is read once at boot, in change-feed's `onReadyBlocking` (after the
// derived-views and derived-tables layers committed), and is fixed for the
// process: the view set and the rollup set only change across a deploy. A read
// before it is set throws — a boot-order bug, never "no bases".
//
// Known limit: a view reading through a function body (plpgsql) is invisible to
// `view_table_usage`, so the tables that body reads are not among its bases.

/** The two graphs relation bases are expanded through. */
export interface RelationGraph {
  /** Each view → the relations it directly reads (`buildViewDeps`). */
  views: ReadonlyMap<string, readonly string[]>;
  /** Each rollup → the source tables whose triggers maintain it (`rollupSources()`). */
  rollups: ReadonlyMap<string, readonly string[]>;
}

/**
 * The memoized relation → bases function over `graph`. Pure. A relation that
 * reaches itself through views or rollups throws (a cycle has no base set),
 * as does a relation named both a view and a rollup.
 */
export function createRelationBases(
  graph: RelationGraph,
): (relation: string) => readonly string[] {
  for (const view of graph.views.keys()) {
    if (graph.rollups.has(view)) {
      throw new Error(
        `[change-feed] relation bases: "${view}" is both a view and a rollup`,
      );
    }
  }
  const memo = new Map<string, readonly string[]>();
  const visiting: string[] = [];
  const expand = (relation: string): readonly string[] => {
    const hit = memo.get(relation);
    if (hit) return hit;
    const reads = graph.views.get(relation) ?? graph.rollups.get(relation);
    if (reads === undefined) {
      const self = [relation];
      memo.set(relation, self);
      return self;
    }
    if (visiting.includes(relation)) {
      throw new Error(
        `[change-feed] relation bases: cycle ${[...visiting.slice(visiting.indexOf(relation)), relation].join(" → ")}`,
      );
    }
    visiting.push(relation);
    const out = new Set<string>();
    try {
      for (const read of reads) for (const base of expand(read)) out.add(base);
    } finally {
      visiting.pop();
    }
    const bases = [...out].sort();
    memo.set(relation, bases);
    return bases;
  };
  return expand;
}

// The process's relation bases: set once at boot by `installRelationGraph`.
let current: ((relation: string) => readonly string[]) | null = null;

/**
 * Install the boot graph (change-feed's `onReadyBlocking`, D34): here, and in
 * server-core's runtime (`setRelationBases`, which indexes every reach plan's
 * relation reads through it).
 */
export function installRelationGraph(graph: RelationGraph): void {
  current = createRelationBases(graph);
  setRelationBases(relationBases);
}

/**
 * The base tables of `relation` under the boot graph. Throws if
 * read before `installRelationGraph` ran.
 */
export function relationBases(relation: string): readonly string[] {
  if (current === null) {
    throw new Error(
      `[change-feed] relationBases("${relation}") read before the boot graph was set — change-feed's onReadyBlocking sets it; a reader must run after it`,
    );
  }
  return current(relation);
}

/**
 * D35: every base table a view or rollup reaches has a change source — a
 * trigger the feed installed, a mounted change producer — or is opted out of
 * the feed (`sourced`). A base outside that set would leave every reader of
 * the relation silently stale. Throws (blocks boot), naming each
 * relation and the base it reaches.
 */
export function assertRelationBasesSourced(
  graph: RelationGraph,
  sourced: ReadonlySet<string>,
): void {
  const bases = createRelationBases(graph);
  const misses: string[] = [];
  for (const [relation, kind] of [
    ...[...graph.views.keys()].map((v) => [v, "view"] as const),
    ...[...graph.rollups.keys()].map((r) => [r, "rollup"] as const),
  ].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const base of bases(relation)) {
      if (!sourced.has(base))
        misses.push(`  - ${kind} "${relation}" → "${base}"`);
    }
  }
  if (misses.length === 0) return;
  throw new Error(
    `[change-feed] ${misses.length} relation base(s) with no change source (D35) — a write to the base reaches no reader of the relation, which serves it stale:\n` +
      misses.join("\n") +
      "\nFix: the base needs a change source (drop its exclusion, or give it a change producer), an explicit `ExcludeFromChangeFeed` opt-out, or the relation must stop reading it.",
  );
}
