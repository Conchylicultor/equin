import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  and,
  canonicalizeFilter,
  clause,
  matchesFilter,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  LIVE_CHILD_COUNT_KEY,
  type LiveCollection,
  type LiveSortDirection,
  type TreeRow,
} from "@plugins/network/plugins/live/core";
import type {
  LazyChildren,
  TreeChildrenState,
} from "@plugins/primitives/plugins/tree/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type {
  DataViewPageNotice,
  DataViewPaging,
  FieldDef,
  FieldGrouping,
  HierarchyConfig,
  LiveDataSource,
  LiveHierarchyConfig,
  LiveTreeDataSource,
  LiveTreeSpec,
  ViewState,
} from "../../../core";
import {
  namedColumnSets,
  type LiveFieldPlan,
  type ResolveOperatorSet,
} from "../live-fields";
import {
  SEARCH_DEBOUNCE_MS,
  useDebounced,
  useLiveSource,
  type SourceView,
} from "../live-source";
import { makeSortComparator } from "../sort-rows";
import { useRowFilter } from "../use-row-filter";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  AliasEdgesReader,
  AliasTargetsReader,
  ChildWindowReader,
  MovedRowReader,
  PathReader,
  type AliasEdge,
  type ChildQuery,
  type ChildReport,
  type MovedRowReport,
  type PathReport,
} from "./readers";
import {
  assembleTreeRows,
  scopedToRoots,
  type PendingTreeMove,
  type TreeRowAccess,
} from "./tree-rows";

// A DataView over a live TREE collection (research/2026-11-05-global-live-bounded-tree.md,
// §4): the rows a nested view draws are read level by level — never the whole
// collection. Two modes, decided by the view's state:
//
// - **expand** (no filter and no search, or the filter tests the roots only):
//   the root window (`parent isEmpty ∧ scope [∧ filter]`), viewport-paged like
//   any live source, plus one `ChildWindowReader` per OPEN node, mounted from
//   the tree's `lazyChildren.onOpenChange` and released on collapse. Memory is
//   the root window plus one window per open node.
// - **hits** (a filter under scope `rows`, or a search): one window over the
//   matches, viewport-paged, with their ancestors (`include: "ancestors"`)
//   drawn as context rows — the in-memory "matches plus ancestors". No child
//   windows: a node shows the hits and ancestors loaded under it.
//
// The source's SCOPE is the root level's: it narrows which roots the tree
// draws, and every subtree under a drawn root is whole — so a node's
// `$childCount` (counted over the collection) is exactly what its child
// window reads, and its chevron never opens onto "Empty".
//
// The rows go to the ordinary nested pipeline (`useHierarchyTree`) with a
// synthetic `HierarchyConfig` whose structure is the collection's `tree`.

/** Which reads a live tree makes. */
export type LiveTreeMode = "expand" | "hits";

/** What a live tree hands the body. */
export interface LiveTreeView<TRow> {
  mode: LiveTreeMode;
  /** The rows drawn (every level's, the context rows, the moves in flight), and the paging of the read behind the roots / hits. */
  origin: SourceView<TRow>;
  /** The structure the nested pipeline nests by: the collection's tree, the consumer's writes and references. */
  hierarchy: HierarchyConfig<TRow>;
  /** The reads behind the rows — the body renders this node (it draws nothing). */
  readers: ReactNode;
  /**
   * In hits mode, the expand map the rows are drawn under: every loaded node
   * holding loaded rows open unless the user closed it (a search opens them
   * all) — a hit is never hidden behind an ancestor nobody opened. `null` in
   * expand mode (the view's own map).
   */
  expanded: Record<string, boolean> | null;
}

/**
 * Read a live tree source for the active (nesting) view. Always called;
 * `null` without a source (the hook order stays fixed).
 */
export function useLiveTree<TRow>(args: {
  source: LiveTreeDataSource<TRow> | undefined;
  /** The surface's collection, named on every render (`useLiveSource`'s `collection`): the tree's reads keep their kind while it is not drawn. */
  collection: LiveDataSource<TRow>["collection"] | null;
  plan: LiveFieldPlan<TRow> | null;
  fields: readonly FieldDef<TRow>[];
  state: ViewState;
  resolveOperatorSet: ResolveOperatorSet;
  resolveGrouping: (typeId: string, groupingId: string) => FieldGrouping;
  now: number;
  collapsedSections: ReadonlySet<string>;
  hierarchy: LiveHierarchyConfig<TRow> | undefined;
  selectedRowId: string | undefined;
}): LiveTreeView<TRow> | null {
  const {
    source,
    collection: surfaceCollection,
    plan,
    fields,
    state,
    resolveOperatorSet,
    resolveGrouping,
    now,
    collapsedSections,
    hierarchy,
    selectedRowId,
  } = args;
  const tree: LiveTreeSpec | null = source?.tree ?? null;
  const collection = source?.collection ?? null;

  // The mode: the search as the read sees it (debounced like the read, so a
  // keystroke never flips to a hits read of no query), and whether the
  // filter narrows anything.
  const query = useDebounced(state.query, SEARCH_DEBOUNCE_MS).trim();
  const filtering =
    useRowFilter(state.filter, fields as FieldDef<TRow>[], resolveOperatorSet)
      .kind !== "all";
  const mode: LiveTreeMode =
    query !== "" || (filtering && (state.filterScope ?? "rows") === "rows")
      ? "hits"
      : "expand";

  const access = useMemo((): TreeRowAccess<TRow> | null => {
    if (tree === null || collection === null) return null;
    const id = collection.id as string;
    return {
      idOf: (row) => String((row as Record<string, unknown>)[id]),
      parentOf: (row) => {
        const p = (row as Record<string, unknown>)[tree.parent];
        return p === null || p === undefined || p === "" ? null : String(p);
      },
    };
  }, [tree, collection]);

  // ── expand mode: the root window (the scope is the roots') ─────────────
  const rootSource = useMemo(
    () =>
      source && tree && mode === "expand"
        ? withRootsScope(source, tree)
        : undefined,
    [source, tree, mode],
  );
  const treeOrder = useMemo(
    () => (tree ? { orderTail: tree.rank } : undefined),
    [tree],
  );
  const hitsOrder = useMemo(
    () =>
      tree
        ? { orderTail: tree.rank, include: "ancestors" as const }
        : undefined,
    [tree],
  );
  const rootView = useLiveSource<TRow>({
    collection: surfaceCollection,
    source: rootSource,
    plan,
    fields,
    state,
    resolveOperatorSet,
    resolveGrouping,
    now,
    collapsedSections,
    tree: treeOrder,
  });

  // ── hits mode: the matches and their ancestors ─────────────────────────
  // The scope is the roots': a hit is read whatever its own columns say, and
  // kept when its drawn root is in scope (below). Group-by over a hits read
  // partitions the loaded forest's roots in memory: a server section of hits
  // would split a subtree across sections.
  const scopeFilter =
    source?.scope.kind === "where" ? source.scope.filter : undefined;
  const hitsSource = useMemo(
    () =>
      source && mode === "hits"
        ? scopeFilter === undefined
          ? source
          : { ...source, scope: { kind: "all" as const } }
        : undefined,
    [source, mode, scopeFilter],
  );
  const hitsState = useMemo(
    () => (state.groupBy ? { ...state, groupBy: undefined } : state),
    [state],
  );
  const hitsView = useLiveSource<TRow>({
    collection: surfaceCollection,
    source: hitsSource,
    plan,
    fields,
    state: hitsState,
    resolveOperatorSet,
    resolveGrouping,
    now,
    collapsedSections,
    tree: hitsOrder,
  });

  // ── open nodes and their child windows (expand mode) ───────────────────
  // Both are the expand mode's own: flipping to hits and back starts them
  // over, so no node opened, and no level read, before the flip survives it.
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(NO_IDS);
  const [reports, setReports] = useState<ReadonlyMap<string, ChildReport>>(
    () => new Map(),
  );
  const [stateMode, setStateMode] = useState(mode);
  if (stateMode !== mode) {
    setStateMode(mode);
    setOpenIds(NO_IDS);
    setReports(new Map());
  }
  const onChild = useCallback(
    (parentId: string, report: ChildReport) =>
      setReports((prev) => {
        if (prev.get(parentId) === report) return prev;
        const next = new Map(prev);
        next.set(parentId, report);
        return next;
      }),
    [],
  );
  // A closed node's report goes with it: its rows are released, never drawn
  // stale on the next open (that open reads again).
  const liveReports = useMemo(() => {
    let pruned: Map<string, ChildReport> | null = null;
    for (const id of reports.keys()) {
      if (openIds.has(id)) continue;
      pruned ??= new Map(reports);
      pruned.delete(id);
    }
    return pruned ?? reports;
  }, [reports, openIds]);
  if (liveReports !== reports) setReports(liveReports);

  // Every level's query: the parent, the view's order (sibling-scoped) ending
  // in the rank. No scope: a subtree under a drawn root is whole.
  const childOrder = useMemo(() => {
    if (!plan || !collection || !tree) return null;
    const order: [string, LiveSortDirection][] =
      state.sort.length > 0
        ? state.sort.map((r) => [
            plan.columnOf.get(r.fieldId) ?? r.fieldId,
            r.direction,
          ])
        : collection.window.window.defaultOrderBy.map(
            ([c, d]) => [c, d] as [string, LiveSortDirection],
          );
    order.push([tree.rank, "asc"]);
    const seen = new Set<string>();
    const orderBy = order.filter(
      ([c]) => !seen.has(c) && seen.add(c) !== undefined,
    );
    return {
      orderBy,
      columns: namedColumnSets(
        plan.handles,
        orderBy.map(([c]) => c),
      ).sets,
    };
  }, [plan, collection, tree, state.sort]);
  const childQueryOf = useMemo(() => {
    if (!source || !tree || !childOrder) return null;
    const declared = source.collection.filterable as unknown as Filterable;
    const cache = new Map<string, ChildQuery>();
    return (parentId: string): ChildQuery => {
      let q = cache.get(parentId);
      if (q === undefined) {
        const where = canonicalizeFilter(
          and(clause(tree.parent, "eq", parentId) as Filter),
          declared,
        );
        if (where === undefined) {
          throw new Error(
            `live-tree: the child filter on "${tree.parent}" canonicalized to no filter`,
          );
        }
        q = { where, ...childOrder };
        cache.set(parentId, q);
      }
      return q;
    };
  }, [source, tree, childOrder]);

  // ── what the windows hold ──────────────────────────────────────────────
  const view = mode === "expand" ? rootView : hitsView;
  const compare = useMemo(() => {
    const bySort =
      state.sort.length > 0
        ? makeSortComparator(state.sort, fields as FieldDef<TRow>[])
        : null;
    const rankCol = tree?.rank;
    const byRank = (a: TRow, b: TRow) =>
      rankCol === undefined
        ? 0
        : Rank.compare(
            rankOf((a as Record<string, unknown>)[rankCol]),
            rankOf((b as Record<string, unknown>)[rankCol]),
          );
    return (a: TRow, b: TRow) => bySort?.(a, b) || byRank(a, b);
  }, [state.sort, fields, tree]);
  const levels = useMemo(() => {
    const out = new Map<string, readonly TRow[]>();
    for (const [parent, report] of liveReports) {
      out.set(parent, report.rows as readonly TRow[]);
    }
    return out;
  }, [liveReports]);
  // The rows the windows DRAW — the roots and the levels hanging from them
  // (a level under a node no window draws is not drawn) — what "loaded"
  // means to a reveal and to a reference.
  const windowRowById = useMemo(() => {
    const byId = new Map<string, TRow>();
    if (!access || !view) return byId;
    const drawn = assembleTreeRows({
      access,
      roots: view.rows,
      levels: mode === "expand" ? levels : undefined,
      compare: NO_ORDER,
    });
    for (const row of drawn.rows) byId.set(access.idOf(row), row);
    return byId;
  }, [view, mode, levels, access]);
  const windowIds = useMemo(
    () => new Set(windowRowById.keys()),
    [windowRowById],
  );

  // ── references (aliases): each held row's edges, read by id ────────────
  // One `{ ids }` read of the edge collection per loaded level (the roots,
  // each open node's children), in chunks of its `maxIds` — so the edges
  // held are the windows' rows', never the edge set. Expand mode only: a
  // hits read opens no node.
  const aliases = hierarchy?.aliases;
  const edgeChunks = useMemo((): readonly EdgeChunk[] => {
    if (!aliases || !access || !view || mode !== "expand") return NO_CHUNKS;
    const size = aliases.collection.rows.point.maxIds;
    const out: EdgeChunk[] = [];
    const chunk = (level: string, rows: readonly TRow[]) => {
      const ids = rows
        .map((r) => access.idOf(r))
        .filter((id) => windowRowById.has(id));
      for (let i = 0; i < ids.length; i += size) {
        const slice = [...new Set(ids.slice(i, i + size))].sort();
        out.push({ key: `${level}\n${i}\n${slice.join("\n")}`, ids: slice });
      }
    };
    chunk("", view.rows);
    for (const [parent, rows] of levels) chunk(parent, rows);
    return out;
  }, [aliases, access, view, mode, levels, windowRowById]);
  const [edgeReads, setEdgeReads] = useState<
    ReadonlyMap<string, ReadonlyMap<string, readonly AliasEdge[]>>
  >(() => new Map());
  const liveEdgeKeys = useMemo(
    () => new Set(edgeChunks.map((c) => c.key)),
    [edgeChunks],
  );
  // A chunk whose read changed (a level grew) keeps the answer of the one it
  // replaced until it answers: a reference never blinks out while re-read.
  // Answers of chunks no longer mounted are dropped on the next answer.
  const liveEdgeKeysRef = useLatestRef(liveEdgeKeys);
  const onEdges = useCallback(
    (key: string, answer: ReadonlyMap<string, readonly AliasEdge[]>) =>
      setEdgeReads((prev) => {
        if (prev.get(key) === answer) return prev;
        const next = new Map<
          string,
          ReadonlyMap<string, readonly AliasEdge[]>
        >();
        for (const [k, v] of prev) {
          if (liveEdgeKeysRef.current.has(k)) next.set(k, v);
        }
        next.set(key, answer);
        return next;
      }),
    [liveEdgeKeysRef],
  );
  const aliasTargets = useMemo(() => {
    const out = new Map<string, readonly AliasEdge[]>();
    // Expand mode's own, like the reads behind it: a hits read draws no
    // reference, never one left from the expand mode before it.
    if (!aliases || mode !== "expand") return out;
    // Stale answers first, so a mounted chunk's answer wins.
    const ordered = [...edgeReads].sort(
      ([a], [b]) => Number(liveEdgeKeys.has(a)) - Number(liveEdgeKeys.has(b)),
    );
    for (const [, answer] of ordered) {
      for (const [id, targets] of answer) out.set(id, targets);
    }
    return out;
  }, [aliases, mode, edgeReads, liveEdgeKeys]);
  // Per parent, the ids it references (what the tree draws under it) and
  // where each sits among its children (`aliases.rank`).
  const aliasIds = useMemo(() => {
    const out = new Map<string, readonly string[]>();
    for (const [parent, edges] of aliasTargets) {
      out.set(
        parent,
        edges.map((e) => e.id),
      );
    }
    return out;
  }, [aliasTargets]);
  const aliasRanks = useMemo(() => {
    const out = new Map<string, ReadonlyMap<string, Rank>>();
    for (const [parent, edges] of aliasTargets) {
      const ranks = new Map<string, Rank>();
      for (const e of edges) if (e.rank !== null) ranks.set(e.id, e.rank);
      if (ranks.size > 0) out.set(parent, ranks);
    }
    return out;
  }, [aliasTargets]);
  const aliasChildrenOf = useCallback(
    (id: string): readonly string[] => aliasIds.get(id) ?? NO_PARENTS,
    [aliasIds],
  );
  const aliasParents = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!aliases) return map;
    for (const parent of openIds) {
      for (const child of aliasChildrenOf(parent)) {
        const list = map.get(child);
        if (list) list.push(parent);
        else map.set(child, [parent]);
      }
    }
    return map;
  }, [aliases, aliasChildrenOf, openIds]);

  // ── reveal: a selected row no window holds ─────────────────────────────
  // Started only once every read that could hold it has answered — the root
  // window and every open node's level — so a row on its way in a level
  // still loading is never read twice; once started it holds until a window
  // draws the row (the levels its own path opens load meanwhile). Expand mode
  // and ungrouped only: a pinned root would belong to no server section.
  // An open level is one the tree has asked for (`openIds`) or is about to
  // (a drawn node the view's expand map opens, whose children exist).
  const viewExpanded = state.expanded;
  const levelsSettled = useMemo(() => {
    const settled = (id: string) => {
      const kind = liveReports.get(id)?.state.kind;
      return kind !== undefined && kind !== "loading";
    };
    if (![...openIds].every(settled)) return false;
    return [...windowIds].every((id) => {
      if (viewExpanded?.[id] !== true) return true;
      const row = windowRowById.get(id);
      return row === undefined || childCountOf(row) === 0 || settled(id);
    });
  }, [openIds, liveReports, windowIds, viewExpanded, windowRowById]);
  const [path, setPath] = useState<{ id: string; report: PathReport } | null>(
    null,
  );
  const revealing = path !== null && path.id === selectedRowId;
  const revealId =
    mode === "expand" &&
    view?.kind === "flat" &&
    selectedRowId !== undefined &&
    !view.loading &&
    (levelsSettled || revealing) &&
    !windowIds.has(selectedRowId)
      ? selectedRowId
      : null;
  const onPath = useCallback(
    (id: string, report: PathReport | null) =>
      setPath((prev) =>
        report === null ? (prev?.id === id ? null : prev) : { id, report },
      ),
    [],
  );
  // Pinned only while the read that found them is mounted: once the row is
  // in a window (or another row is selected) the reader goes, and its pins
  // with it.
  const backedPath = path !== null && path.id === revealId ? path.report : null;
  const pathRows = useMemo((): readonly TRow[] => {
    if (backedPath?.kind !== "found") return NO_ROWS_T<TRow>();
    return [
      ...(backedPath.ancestors as readonly TRow[]),
      backedPath.row as TRow,
    ];
  }, [backedPath]);
  // A failed reveal is the reveal's own state, beside a healthy tree: a
  // notice with its Retry, never the view's failure.
  const revealNotice = useMemo(
    (): DataViewPageNotice | null =>
      backedPath?.kind === "failed"
        ? {
            key: `live-tree:reveal:${revealId}`,
            afterRowId: null,
            error: backedPath.error,
            retry: backedPath.retry,
          }
        : null,
    [backedPath, revealId],
  );

  // ── alias targets an open node draws that no window holds: by id ───────
  const missingAliasIds = useMemo(
    () =>
      mode === "expand"
        ? [...aliasParents.keys()].filter((id) => !windowIds.has(id)).sort()
        : [],
    [mode, aliasParents, windowIds],
  );
  const [aliasRead, setAliasRead] = useState<{
    key: string;
    rows: readonly unknown[];
  } | null>(null);
  const onAliasRows = useCallback(
    (key: string, rows: readonly unknown[]) =>
      setAliasRead((prev) =>
        prev?.key === key && prev.rows === rows ? prev : { key, rows },
      ),
    [],
  );
  const aliasKey = missingAliasIds.join("\n");
  const referenceRows = useMemo(
    () =>
      aliasRead !== null && aliasRead.key === aliasKey
        ? (aliasRead.rows as readonly TRow[])
        : NO_ROWS_T<TRow>(),
    [aliasRead, aliasKey],
  );

  // ── moves in flight ────────────────────────────────────────────────────
  // Each pending drop is followed by a live read of the moved row
  // (`MovedRowReader`): it is drawn from that read (from its window copy
  // until the read answers), and the move settles when the read says its
  // parent IS the destination — or the row is gone, or the write rejects.
  // Never by whether some window happens to hold it: a row landing past a
  // level's loaded prefix is settled all the same, and simply not drawn.
  type Move = Omit<PendingTreeMove<TRow>, "row"> & { id: string; copy: TRow };
  const [moves, setMoves] = useState<readonly Move[]>(NO_MOVES_T<Move>());
  const [movedRows, setMovedRows] = useState<
    ReadonlyMap<string, MovedRowReport>
  >(() => new Map());
  const onMovedRow = useCallback(
    (id: string, report: MovedRowReport | null) =>
      setMovedRows((prev) => {
        if (prev.get(id) === report) return prev;
        const next = new Map(prev);
        if (report === null) next.delete(id);
        else next.set(id, report);
        return next;
      }),
    [],
  );
  const liveMoves = useMemo(() => {
    if (!access || moves.length === 0) return moves;
    const kept = moves.filter((m) => {
      const live = movedRows.get(m.id);
      if (live === undefined || live.kind === "pending") return true;
      if (live.kind === "gone") return false;
      return access.parentOf(live.row as TRow) !== m.parentId;
    });
    return kept.length === moves.length ? moves : kept;
  }, [moves, access, movedRows]);
  if (liveMoves !== moves) setMoves(liveMoves);

  // ── the drawn rows ─────────────────────────────────────────────────────
  const windowCopy = useMemo(() => {
    const byId = new Map<string, TRow>();
    if (!access || !view) return byId;
    for (const row of view.rows) byId.set(access.idOf(row), row);
    for (const rows of levels.values()) {
      for (const row of rows) byId.set(access.idOf(row), row);
    }
    return byId;
  }, [access, view, levels]);
  const assembled = useMemo(() => {
    if (!access || !view) return null;
    const sectioned = view.kind === "sectioned";
    const pending = liveMoves
      // A root-level move under server sections would land in no section.
      .filter((m) => !sectioned || m.parentId !== null)
      .map((m): PendingTreeMove<TRow> => {
        const live = movedRows.get(m.id);
        const row =
          live?.kind === "found"
            ? (live.row as TRow)
            : (windowCopy.get(m.id) ?? m.copy);
        return {
          row,
          parentId: m.parentId,
          targetId: m.targetId,
          zone: m.zone,
        };
      });
    return assembleTreeRows({
      access,
      roots: view.rows,
      levels: mode === "expand" ? levels : undefined,
      pins:
        mode === "hits"
          ? view.kind === "flat"
            ? view.ancestors
            : []
          : pathRows,
      compare,
      moves: pending,
    });
  }, [
    access,
    view,
    mode,
    levels,
    pathRows,
    compare,
    liveMoves,
    movedRows,
    windowCopy,
  ]);

  // The scope is the roots': in hits mode a row is drawn only under a root
  // the scope admits (in expand mode the root window already is the scope's).
  const declared = source?.collection.filterable as unknown as
    Filterable | undefined;
  // A hit whose chain has not answered yet (its page's ancestors pending) is
  // PENDING — held out of the drawn rows and drawn as the read growing (the
  // footer's loading line), never as a root it is not: it joins its chain
  // the moment its ancestors land. Only once every page's ancestors answered
  // is a row with no drawn parent an orphan (drawn as a root).
  const ancestorsPending =
    mode === "hits" && view?.kind === "flat" && view.ancestorsPending;
  const scoped = useMemo((): readonly TRow[] => {
    if (!assembled || !access) return NO_ROWS_T<TRow>();
    const held = ancestorsPending ? assembled.orphans : NO_IDS;
    const drawn =
      held.size === 0
        ? assembled
        : {
            ...assembled,
            rows: assembled.rows.filter((r) => !held.has(access.idOf(r))),
          };
    if (mode !== "hits" || scopeFilter === undefined) return drawn.rows;
    return scopedToRoots(drawn, access.idOf, (root) =>
      matchesFilter(
        root as Readonly<Record<string, unknown>>,
        scopeFilter,
        declared!,
      ),
    );
  }, [assembled, access, mode, scopeFilter, declared, ancestorsPending]);

  // The references, drawn only under their alias parents.
  const rows = useMemo(() => {
    if (referenceRows.length === 0 || !access) return scoped;
    const drawn = new Set(scoped.map((r) => access.idOf(r)));
    return [
      ...scoped,
      ...referenceRows.filter((r) => !drawn.has(access.idOf(r))),
    ];
  }, [scoped, referenceRows, access]);
  const rowById = useMemo(
    () => new Map(access ? rows.map((r) => [access.idOf(r), r]) : []),
    [rows, access],
  );
  const referenceIds = useMemo(
    () => new Set(access ? referenceRows.map((r) => access.idOf(r)) : []),
    [referenceRows, access],
  );

  // ── the synthetic hierarchy ────────────────────────────────────────────
  const sorted = state.sort.length > 0;
  const onMove = hierarchy?.onMove;
  const onCreate = hierarchy?.onCreate;
  // Expand mode only: a hits node's children are the ones drawn (its chevron
  // is "has drawn children" — the tree's own count), never `$childCount`,
  // which would offer an open that reads nothing.
  const lazyChildren = useMemo((): LazyChildren<TRow> | undefined => {
    if (mode !== "expand" || !access) return undefined;
    const aliasCount = (id: string) => aliasChildrenOf(id).length;
    return {
      hasChildren: (row) =>
        childCountOf(row) > 0 || aliasCount(access.idOf(row)) > 0,
      state: (row): TreeChildrenState => {
        const id = access.idOf(row);
        if (!openIds.has(id)) return UNLOADED;
        return liveReports.get(id)?.state ?? LOADING;
      },
      load: (row) => {
        const id = access.idOf(row);
        setOpenIds((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
      },
      onOpenChange: (open) => {
        const next = new Set(open.map((r) => access.idOf(r)));
        setOpenIds((prev) => (sameSet(prev, next) ? prev : next));
      },
    };
  }, [mode, access, openIds, liveReports, aliasChildrenOf]);

  const synthetic = useMemo((): HierarchyConfig<TRow> | null => {
    if (!access || !tree || !assembled) return null;
    const { parentOf } = assembled;
    return {
      getParentId: (row) => {
        const id = access.idOf(row);
        return parentOf.has(id) ? parentOf.get(id)! : access.parentOf(row);
      },
      getRank: (row) => rankOf((row as Record<string, unknown>)[tree.rank]),
      ...(aliases
        ? {
            getAliasParents: (row: TRow) =>
              aliasParents.get(access.idOf(row)) ?? NO_PARENTS,
            getAliasRank: (row: TRow, parentId: string) =>
              aliasRanks.get(parentId)?.get(access.idOf(row)) ?? null,
            referenceOnly: (row: TRow) =>
              referenceIds.has(access.idOf(row)) &&
              !windowIds.has(access.idOf(row)),
          }
        : {}),
      // A sort orders each sibling list: a drop would move a row with no
      // visible effect, so no drag while sorted (as in memory).
      ...(onMove && !sorted
        ? {
            onMove: (id, dest) => {
              const copy = rowById.get(id);
              const result = onMove(id, dest);
              if (result === undefined || copy === undefined) return result;
              const move: Move = { id, copy, ...dest };
              setMoves((prev) => [...prev.filter((m) => m.id !== id), move]);
              return result.then(undefined, (err: unknown) => {
                setMoves((prev) => prev.filter((m) => m !== move));
                throw err;
              });
            },
          }
        : {}),
      ...(onCreate ? { onCreate } : {}),
      ...(lazyChildren ? { lazyChildren } : {}),
    } satisfies HierarchyConfig<TRow>;
  }, [
    access,
    tree,
    assembled,
    aliases,
    aliasParents,
    aliasRanks,
    referenceIds,
    windowIds,
    onMove,
    sorted,
    rowById,
    onCreate,
    lazyChildren,
  ]);

  // The read's own rows (its paging's): the roots / hits, in read order.
  const pagedIds = useMemo(
    () => new Set(access && view ? view.rows.map((r) => access.idOf(r)) : []),
    [access, view],
  );
  const origin = useMemo((): SourceView<TRow> | null => {
    if (!view || !access) return null;
    if (view.kind === "sectioned") return { ...view, rows };
    const paging: DataViewPaging<TRow> = {
      ...view.paging,
      growing: view.paging.growing || ancestorsPending,
      isPaged: (row) => pagedIds.has(access.idOf(row)),
      notices:
        revealNotice === null
          ? view.paging.notices
          : [...view.paging.notices, revealNotice],
    };
    return { ...view, rows, paging };
  }, [view, access, rows, pagedIds, revealNotice, ancestorsPending]);

  // Hits mode: every node holding loaded rows open unless the user closed it;
  // a search opens them all.
  const expanded = useMemo(() => {
    if (mode !== "hits" || !synthetic) return null;
    const out: Record<string, boolean> = {};
    for (const row of rows) {
      const parent = synthetic.getParentId(row);
      if (parent === null) continue;
      out[parent] = query !== "" ? true : (viewExpanded?.[parent] ?? true);
    }
    return { ...viewExpanded, ...out };
  }, [mode, synthetic, rows, query, viewExpanded]);

  const anyCollection = collection as LiveCollection<unknown, unknown, string>;
  const readers =
    source && collection ? (
      <>
        {view?.kind === "sectioned" ? view.readers : null}
        {mode === "expand" && childQueryOf
          ? [...openIds].map((id) => (
              <ChildWindowReader
                key={id}
                collection={anyCollection}
                parentId={id}
                query={childQueryOf(id)}
                onResult={onChild}
              />
            ))
          : null}
        {revealId !== null ? (
          <PathReader
            key={revealId}
            collection={anyCollection}
            id={revealId}
            onResult={onPath}
          />
        ) : null}
        {aliases
          ? edgeChunks.map((c) => (
              <AliasEdgesReader
                key={c.key}
                collection={aliases.collection}
                readKey={c.key}
                ids={c.ids}
                targets={aliases.targets}
                rank={aliases.rank}
                onResult={onEdges}
              />
            ))
          : null}
        {missingAliasIds.length > 0 ? (
          <AliasTargetsReader
            collection={anyCollection}
            ids={missingAliasIds}
            onResult={onAliasRows}
          />
        ) : null}
        {liveMoves.map((m) => (
          <MovedRowReader
            key={m.id}
            collection={anyCollection}
            id={m.id}
            onResult={onMovedRow}
          />
        ))}
      </>
    ) : null;

  if (!source || !origin || !synthetic) return null;
  return { mode, origin, hierarchy: synthetic, readers, expanded };
}

/**
 * The source scoped to the roots — `parent isEmpty` ANDed into its scope (an
 * awaiting scope stays awaiting: it reads nothing yet).
 */
export function withRootsScope<TRow>(
  source: LiveDataSource<TRow>,
  tree: LiveTreeSpec,
): LiveDataSource<TRow> {
  if (source.scope.kind === "awaiting") return source;
  const own = clause(tree.parent, "isEmpty") as Filter;
  const filter = canonicalizeFilter(
    source.scope.kind === "where" ? and(source.scope.filter, own) : and(own),
    source.collection.filterable as unknown as Filterable,
  );
  if (filter === undefined) {
    throw new Error(
      `live-tree: the roots filter on "${tree.parent}" canonicalized to no filter`,
    );
  }
  return { ...source, scope: { kind: "where", filter } };
}

/**
 * A tree row's child count (`$childCount`, carried by every row of a tree
 * collection). A row without one is a collection that is no tree, or a
 * server that does not count — loud, never "no children".
 */
export function childCountOf(row: unknown): number {
  const n = (row as Partial<TreeRow<unknown>>)[LIVE_CHILD_COUNT_KEY];
  if (typeof n !== "number") {
    throw new Error(
      "live-tree: a row of a tree collection carries no `$childCount` — the server must count each row's children",
    );
  }
  return n;
}

/** A rank column's value as a `Rank` (decoded already, or its string). */
function rankOf(value: unknown): Rank {
  return value instanceof Rank ? value : Rank.from(String(value));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** One `{ ids }` read of a level's edges: its key (level, offset, ids) and the ids. */
interface EdgeChunk {
  key: string;
  ids: readonly string[];
}

const NO_IDS: ReadonlySet<string> = new Set();
const NO_CHUNKS: readonly EdgeChunk[] = [];
const NO_ORDER = () => 0;
const NO_MOVES: readonly unknown[] = [];
const NO_MOVES_T = <T,>() => NO_MOVES as readonly T[];
const NO_PARENTS: readonly string[] = [];
const NO_ROWS: readonly unknown[] = [];
const NO_ROWS_T = <T,>() => NO_ROWS as readonly T[];
const UNLOADED: TreeChildrenState = { kind: "unloaded" };
const LOADING: TreeChildrenState = { kind: "loading" };
