import { useMemo, useState } from "react";
import {
  useResources,
  type ResourceError,
  type ResourceTupleResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { LiveTreeCollection } from "@plugins/network/plugins/live/core";

// `include: "ancestors"` — what a tree collection's read adds beside its rows:
// every ancestor of them that the read does not hold, read through the
// collection's `:ancestors` sibling (a seed set → the seeds and their whole
// chains, one round trip). Composed here, never mixed into the rows:
//
// - a window read (`useLive(c, { …, include: "ancestors" }[, { viewport }])`)
//   reads ONE `:ancestors` tuple per loaded PAGE, seeded by the parents of
//   that page's rows the page does not hold — so a page's tuple moves only
//   with its own rows (page independence), and a new page adds one tuple;
// - a row read (`useLive(c, { id, include: "ancestors" })`) reads one tuple
//   seeded by the row's parent, answered root-first.
//
// Not known yet is a state, never a stand-in. A tuple IS its seed set: it
// answers only for those seeds, and keeps its answer while they stand (a kept
// tuple stays settled); new seeds are a new tuple with no answer yet — never
// another tuple's, nor an older answer for other seeds.
//
// - A window read is `loading` until every tuple of the read has answered
//   once. From then on it stays `ready` (paging never flips back): the
//   answered tuples' ancestors, and `pending: true` while a tuple (a new page,
//   a page whose rows moved) has not answered — its ancestors are missing,
//   and the flag says so.
// - A row read reads one tuple (its parent's): `loading` whenever that tuple
//   has not answered — a re-parented row is not known until its new chain is.

/** What the ancestors of a read stand at. */
export type AncestorsState<Row> =
  | { status: "loading" }
  | { status: "error"; error: ResourceError; refetch: () => Promise<void> }
  | {
      status: "ready";
      rows: readonly Row[];
      /** A tuple of the read has not answered yet: its ancestors are not in `rows`. */
      pending: boolean;
    };

/** A tree row's parent id, read off its `tree.parent` field (`null` at a root). */
function parentOf(row: unknown, field: string): string | null {
  const v = (row as Record<string, unknown>)[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(
      `include "ancestors": the parent field "${field}" holds ${JSON.stringify(v)}, not an id`,
    );
  }
  return v;
}

/** The id of a row of `collection`. */
function idOf(row: unknown, field: string): string {
  return String((row as Record<string, unknown>)[field]);
}

/**
 * The ancestors of `segments` (a read's rows, one segment per page — `null`
 * while they are not known): one `:ancestors` tuple per segment holding a
 * parent it does not hold, their union minus every row of `segments`.
 */
export function useSegmentAncestors<Row>(
  collection: LiveTreeCollection<Row, unknown, string>,
  segments: readonly (readonly Row[])[] | null,
): AncestorsState<Row> {
  const { tree, ancestors: descriptor, id } = collection;
  const idField = id as string;
  // The seeds of each segment, as the tuple's canonical params (the point
  // codec sorts and dedupes) — keyed by their JSON so a re-render with the
  // same rows reads the same tuples.
  const seedSets = (segments ?? []).map((rows) => {
    const own = new Set(rows.map((r) => idOf(r, idField)));
    const seeds = new Set<string>();
    for (const r of rows) {
      const p = parentOf(r, tree.parent);
      if (p !== null && !own.has(p)) seeds.add(p);
    }
    return [...seeds];
  });
  const paramsJson = JSON.stringify(
    seedSets.filter((s) => s.length > 0).map((s) => descriptor.point.encode(s)),
  );
  const params = useMemo(
    () => JSON.parse(paramsJson) as { ids: string }[],
    [paramsJson],
  );
  const results = useResources(descriptor, params, { release: "now" });
  const held = useMemo(
    () =>
      new Set(
        (segments ?? []).flatMap((rows) => rows.map((r) => idOf(r, idField))),
      ),
    [segments, idField],
  );
  // A list the hook has not caught up with yet (the tuples it answers are
  // not this render's) is no answer.
  const current = useMemo(
    (): Union<Row> | null =>
      segments === null || results.length !== params.length
        ? null
        : unionOf(results, held, idField),
    [segments, results, params, held, idField],
  );
  // Whether this read has had every tuple answered once — reset when its rows
  // are not known (a new query): only then may a tuple still loading leave it
  // `ready`, flagged `pending` (adjusted during render — state derived from a
  // changed input).
  const [settled, setSettled] = useState(false);
  if (current === null) {
    if (segments === null && settled) setSettled(false);
    return { status: "loading" };
  }
  if (current.status === "error") return current;
  if (!current.pending && !settled) setSettled(true);
  if (current.pending && !settled) return { status: "loading" };
  return current;
}

/**
 * The ancestors of one row (`useLive(c, { id, include: "ancestors" })`): its
 * parent's chain up to the root, root-first; none for a root or a row not
 * found (`row` `null`), `null` while the row is not known.
 */
export function useRowAncestors<Row>(
  collection: LiveTreeCollection<Row, unknown, string>,
  row: Row | null | undefined,
): AncestorsState<Row> {
  const segments = useMemo(
    () => (row === undefined ? null : row === null ? [] : [[row]]),
    [row],
  );
  const state = useSegmentAncestors(collection, segments);
  const { tree, id } = collection;
  return useMemo((): AncestorsState<Row> => {
    if (state.status !== "ready") return state;
    // One tuple: the row's parent's. Unanswered, the chain is not known.
    if (state.pending) return { status: "loading" };
    if (row === null || row === undefined) return state;
    const byId = new Map(state.rows.map((r) => [idOf(r, id as string), r]));
    const path: Row[] = [];
    const seen = new Set<string>();
    let p = parentOf(row, tree.parent);
    while (p !== null) {
      const up = byId.get(p);
      // The chain ends where the collection does (a parent outside its
      // `where`, or deleted since): what the server answered is the path.
      if (up === undefined || seen.has(p)) break;
      seen.add(p);
      path.push(up);
      p = parentOf(up, tree.parent);
    }
    return { status: "ready", rows: path.reverse(), pending: false };
  }, [state, row, tree, id]);
}

type Union<Row> =
  | { status: "error"; error: ResourceError; refetch: () => Promise<void> }
  | { status: "ready"; rows: readonly Row[]; pending: boolean };

/**
 * Every ANSWERED tuple's rows, unioned (each id once) minus `held` —
 * `pending` while a tuple has not answered (its rows are not in it).
 */
function unionOf<Row>(
  results: readonly ResourceTupleResult<Row[]>[],
  held: ReadonlySet<string>,
  idField: string,
): Union<Row> {
  const out = new Map<string, Row>();
  let partial = false;
  for (const r of results) {
    if (r.status === "error") {
      return { status: "error", error: r.error, refetch: r.refetch };
    }
    if (r.status === "loading") {
      partial = true;
      continue;
    }
    for (const row of r.data) {
      const key = idOf(row, idField);
      if (!held.has(key) && !out.has(key)) out.set(key, row);
    }
  }
  return { status: "ready", rows: [...out.values()], pending: partial };
}
