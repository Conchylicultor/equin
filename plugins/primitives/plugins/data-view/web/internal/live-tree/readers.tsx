import { useEffect, useMemo, type ReactNode } from "react";
import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveCollection,
  LiveColumnsDeclaration,
  LiveOrderBy,
  LiveRowsCollection,
  LiveTreeCollection,
} from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { TreeChildrenState } from "@plugins/primitives/plugins/tree/core";

// The reads of a live tree beyond its root window, each a sibling component
// that reports up (the `live-sections.tsx` / file explorer `ListingReader`
// pattern): mounting one is subscribing, unmounting it releases the read —
// so a node collapsed costs nothing, and no hook runs in a loop.
//
// A report is rebuilt only when what it SAYS changes — its rows' identity and
// the read's state, never the read object's own identity — and its callbacks
// are stable (they call the latest read), so a read handing back a fresh
// object for an unchanged answer reports nothing new and cannot loop.

type AnyCollection = LiveCollection<unknown, unknown, string>;

/** What one open node's child window reports: its rows so far, and where its listing stands. */
export interface ChildReport {
  rows: readonly unknown[];
  state: TreeChildrenState;
}

/** A child window's query: everything but the parent is the level's. */
export interface ChildQuery {
  where: Filter;
  orderBy: LiveOrderBy<string>;
  columns: readonly LiveColumnsDeclaration[];
}

/**
 * One open node's children (renders nothing): `where parent = X`, the level's
 * order, grown by `loadMore` — the tree's `partial` state ("Load more" after
 * the loaded children) until the window holds every child.
 */
export function ChildWindowReader(props: {
  collection: AnyCollection;
  parentId: string;
  query: ChildQuery;
  onResult: (parentId: string, report: ChildReport) => void;
}): ReactNode {
  const { collection, parentId, query, onResult } = props;
  const read = useLive(collection, {
    where: query.where,
    orderBy: query.orderBy,
    ...(query.columns.length > 0 ? { columns: query.columns } : {}),
  });
  const loadMore = useEventCallback(() => {
    switch (read.status) {
      case "ready":
        read.loadMore();
        return;
      case "loading":
      case "error":
        throw new Error(
          "live-tree: Load more on a level whose read is not ready",
        );
    }
  });
  const retry = useEventCallback(() => void read.refetch());
  // What the report says, as values: a fresh read object with the same
  // answer changes none of them.
  let phase: "loading" | "error" | "ready";
  let rows: readonly unknown[] = NO_ROWS;
  let message: string | null = null;
  let canGrow = false;
  let growing = false;
  switch (read.status) {
    case "loading":
      phase = "loading";
      break;
    case "error":
      phase = "error";
      rows = read.stale ?? NO_ROWS;
      message = read.error.message;
      break;
    case "ready":
      phase = "ready";
      rows = read.data;
      canGrow = read.canGrow;
      growing = read.growing;
      break;
  }
  const report = useMemo((): ChildReport => {
    switch (phase) {
      case "loading":
        return { rows, state: LOADING };
      case "error":
        // A failure over rows seen keeps them drawn, and says so: a stale
        // listing must not read as a current one.
        return {
          rows,
          state: { kind: "failed", message: message ?? "", retry },
        };
      case "ready":
        return {
          rows,
          state: canGrow
            ? { kind: "partial", growing, loadMore, stalled: null }
            : LOADED,
        };
    }
  }, [phase, rows, message, canGrow, growing, loadMore, retry]);
  useEffect(() => onResult(parentId, report), [onResult, parentId, report]);
  return null;
}

/** What a point read of a live tree reports: the row (when found) and its ancestors. */
export type PathReport =
  | { kind: "pending" }
  | { kind: "missing" }
  | { kind: "failed"; error: Error; retry: () => void }
  | { kind: "found"; row: unknown; ancestors: readonly unknown[] };

/**
 * The path of a row the tree has not loaded (a deep link, a selection made
 * elsewhere): the row and every ancestor, in one read
 * (`useLive(c, { id, include: "ancestors" })`). Renders nothing; reports
 * `null` when it unmounts — a path pinned in is only ever one a live read
 * backs.
 */
export function PathReader(props: {
  collection: AnyCollection;
  id: string;
  onResult: (id: string, report: PathReport | null) => void;
}): ReactNode {
  const { collection, id, onResult } = props;
  const read = useLive(
    collection as LiveTreeCollection<unknown, unknown, string>,
    { id, include: "ancestors" },
  );
  const retry = useEventCallback(() => void read.refetch());
  let phase: "loading" | "error" | "found" | "missing";
  let row: unknown = null;
  let ancestors: readonly unknown[] | null = null;
  let error: Error | null = null;
  switch (read.status) {
    case "loading":
      phase = "loading";
      break;
    case "error":
      phase = "error";
      error = read.error;
      break;
    case "ready":
      if (read.found) {
        phase = "found";
        row = read.row;
        ancestors = read.ancestors;
      } else phase = "missing";
      break;
  }
  const report = useMemo((): PathReport => {
    switch (phase) {
      case "loading":
        return { kind: "pending" };
      case "error":
        return { kind: "failed", error: error!, retry };
      case "found":
        return { kind: "found", row, ancestors: ancestors! };
      case "missing":
        return { kind: "missing" };
    }
  }, [phase, row, ancestors, error, retry]);
  useEffect(() => onResult(id, report), [onResult, id, report]);
  useEffect(() => () => onResult(id, null), [onResult, id]);
  return null;
}

/** What the live read of a moved row says: not known yet, the row as it is now, or gone. */
export type MovedRowReport =
  { kind: "pending" } | { kind: "found"; row: unknown } | { kind: "gone" };

/**
 * The live read of a row a drop moved, while the move is in flight
 * (`useLive(c, { id })`): the move is drawn from it, and settles once it
 * says the row's parent is the destination (or the row is gone). Renders
 * nothing; a failed read reports `pending` — the move stays drawn from the
 * last copy until the read answers, and the write's own rejection still
 * ends it.
 */
export function MovedRowReader(props: {
  collection: AnyCollection;
  id: string;
  onResult: (id: string, report: MovedRowReport | null) => void;
}): ReactNode {
  const { collection, id, onResult } = props;
  const read = useLive(collection, { id });
  let phase: MovedRowReport["kind"] = "pending";
  let row: unknown = null;
  switch (read.status) {
    case "loading":
    case "error":
      break;
    case "ready":
      if (read.found) {
        phase = "found";
        row = read.row;
      } else phase = "gone";
      break;
  }
  const report = useMemo(
    (): MovedRowReport =>
      phase === "found" ? { kind: "found", row } : { kind: phase },
    [phase, row],
  );
  useEffect(() => onResult(id, report), [onResult, id, report]);
  useEffect(() => () => onResult(id, null), [onResult, id]);
  return null;
}

/**
 * The rows open nodes draw as references (`LiveHierarchyConfig.aliases`) that the tree
 * has not loaded, read by id. Renders nothing; reports the rows found.
 */
export function AliasTargetsReader(props: {
  collection: AnyCollection;
  ids: readonly string[];
  onResult: (ids: string, rows: readonly unknown[]) => void;
}): ReactNode {
  const { collection, ids, onResult } = props;
  const read = useLive(collection, { ids: [...ids] });
  const key = ids.join("\n");
  // Not read yet, or failed with nothing seen: no reference drawn (the node's
  // own children still are).
  const rows = foldResource(read, {
    ready: (data) => data as readonly unknown[],
    loading: () => NO_ROWS,
    error: (_error, stale) =>
      (stale as readonly unknown[] | undefined) ?? NO_ROWS,
  });
  useEffect(() => onResult(key, rows), [onResult, key, rows]);
  return null;
}

/**
 * One chunk of a level's reference edges (`LiveHierarchyConfig.aliases`):
 * ONE `{ ids }` read of the edge collection for the rows a level holds.
 * Renders nothing; reports, once the read has answered, each asked id's
 * referenced ids (`[]` for an id the collection holds no row for). Nothing is
 * reported while loading, and a failure reports what it last saw — the tree's
 * own rows still draw; only the references wait (an enrichment, never the
 * hierarchy).
 */
export function AliasEdgesReader(props: {
  collection: LiveRowsCollection<unknown> & { readonly id: string };
  readKey: string;
  ids: readonly string[];
  targets: (edges: unknown) => readonly string[];
  onResult: (
    readKey: string,
    answer: ReadonlyMap<string, readonly string[]>,
  ) => void;
}): ReactNode {
  const { collection, readKey, ids, targets, onResult } = props;
  // Erased: any collection answers `{ ids }` through its `:rows`.
  const read = useLive(collection as AnyCollection, { ids: [...ids] });
  const rows = foldResource(read, {
    ready: (data) => data as readonly unknown[],
    loading: () => null,
    error: (_error, stale) => (stale as readonly unknown[] | undefined) ?? null,
  });
  const idField = collection.id;
  const answer = useMemo(() => {
    if (rows === null) return null;
    const out = new Map<string, readonly string[]>();
    for (const id of ids) out.set(id, NO_TARGETS);
    for (const row of rows) {
      out.set(String((row as Record<string, unknown>)[idField]), targets(row));
    }
    return out;
  }, [rows, ids, idField, targets]);
  useEffect(() => {
    if (answer !== null) onResult(readKey, answer);
  }, [onResult, readKey, answer]);
  return null;
}

const NO_TARGETS: readonly string[] = [];
const NO_ROWS: readonly unknown[] = [];
const LOADING: TreeChildrenState = { kind: "loading" };
const LOADED: TreeChildrenState = { kind: "loaded" };
