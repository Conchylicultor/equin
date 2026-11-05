/**
 * A DataView over a live TREE collection (`web/internal/live-tree/`), end to
 * end through the real body: a `DataViewSwitcher` whose source is a
 * `liveDataSource` over a collection declaring `tree`, the view model stubbed
 * (its expand map held here), `useLive` faked (every read the tree makes is
 * recorded with its query, and answered by the test), and one minimal view
 * that runs the real nested pipeline (`useHierarchyTree` → `useTreeModel`)
 * and prints its painted lines.
 *
 * - expand mode: the root window is `parent isEmpty`; opening a node mounts
 *   its child window (`parent = X`, ordered `[sort…, rank]`), closing it
 *   releases the read;
 * - a partial level draws "Load more" after its loaded children, and it grows
 *   that level;
 * - siblings are drawn in window order (a sort is the server's);
 * - hits mode: a search reads the matches with their ancestors, drawn open, no
 *   child windows;
 * - group-by over the roots: server sections, children follow their root;
 * - a selected row no window holds is read with its path and pinned in;
 * - a reparent in flight is drawn at its destination until that level holds it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

// ── the fake `useLive`: every read keyed by (collection, query, viewport) ──
const fake = vi.hoisted(() => {
  type Listener = () => void;
  const results = new Map<string, unknown>();
  const mounted = new Map<string, number>();
  const listeners = new Set<Listener>();
  const LOADING = { status: "loading", refetch: async () => {} };
  const keyOf = (c: unknown, q: unknown, opts: unknown) =>
    JSON.stringify([
      (c as { key?: string } | null)?.key ?? null,
      q ?? null,
      !!(opts as { viewport?: unknown } | undefined)?.viewport,
    ]);
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return { results, mounted, listeners, LOADING, keyOf, notify };
});
vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => {
  const actual = await importOriginal<object>();
  const React = await import("react");
  return {
    ...actual,
    useLive: (c: unknown, q: unknown, opts: unknown) => {
      const key = fake.keyOf(c, q, opts);
      React.useEffect(() => {
        if (c == null || q == null) return;
        fake.mounted.set(key, (fake.mounted.get(key) ?? 0) + 1);
        return () => {
          fake.mounted.set(key, fake.mounted.get(key)! - 1);
        };
      }, [key, c, q]);
      return React.useSyncExternalStore(
        (l: () => void) => {
          fake.listeners.add(l);
          return () => fake.listeners.delete(l);
        },
        () => fake.results.get(key) ?? fake.LOADING,
      );
    },
  };
});

// The view model, its expand map held here so a toggle re-renders.
const modelStore = vi.hoisted(() => {
  let model: unknown = null;
  const listeners = new Set<() => void>();
  return {
    get: () => model,
    set: (next: unknown) => {
      model = next;
      for (const l of [...listeners]) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
});
vi.mock("../internal/use-data-view-model", async () => {
  const React = await import("react");
  return {
    useDataViewModel: () =>
      React.useSyncExternalStore(modelStore.subscribe, modelStore.get),
  };
});

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  liveCollection,
  type LiveCollection,
} from "@plugins/network/plugins/live/core";
import type { ExpandChange } from "@plugins/primitives/plugins/tree/core";
import {
  flatExpandAll,
  useTreeModel,
} from "@plugins/primitives/plugins/tree/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  DataViewId,
  DataViewRenderProps,
  FieldDef,
  LiveHierarchyConfig,
  LiveTreeDataSource,
  ViewState,
} from "../../core";
import { liveDataSource } from "../internal/live-data-source";
import { treeAliases } from "../internal/live-tree/tree-aliases";
import { aliasNodeId } from "../internal/hierarchy/project-rows";
import { defineDataViewSources } from "../internal/define-data-view-sources";
import { useHierarchyTree } from "../internal/hierarchy/use-hierarchy-tree";
import { withLiveParentField } from "../internal/flat-hierarchy";
import { RowReadsHost, withRowReadCells } from "../internal/row-reads";
import { DataViewSwitcher } from "../components/data-view-switcher";
import { DataViewSlots } from "../slots";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

const STORAGE_KEY = "test-live-tree" as DataViewId;
const NO_COLLAPSED: ReadonlySet<string> = new Set();
const SECTION = { collapsed: false, hideWhenEmpty: false, description: null };

type Node = {
  id: string;
  title: string;
  kind: string;
  parentId: string | null;
  rank: string;
  $childCount: number;
};

let n = 0;
const nodes = () => {
  return liveCollection(`test.data-view.live-tree-${n++}`, {
    fields: {
      title: textField({ label: "Title" }),
      kind: textField({ label: "Kind" }),
      parentId: nullable(textField({ label: "Parent" })),
      rank: textField({ label: "Rank" }),
    },
    carry: { fields: { id: textField() } },
    id: "id",
    sortable: ["rank", "title"],
    default: { orderBy: [["rank", "asc"]], limit: 50 },
    maxLimit: 200,
    tree: { parent: "parentId", rank: "rank" },
  });
};
type C = ReturnType<typeof nodes>;

const row = (
  id: string,
  parentId: string | null,
  rank: string,
  childCount = 0,
  kind = "k",
): Node => ({ id, title: id, kind, parentId, rank, $childCount: childCount });

// ── the view: the real nested pipeline, its painted lines as text ──────────
const moveErrors: unknown[] = [];
let reportCount = 0;
let moveArgs: Parameters<
  NonNullable<LiveHierarchyConfig<Node>["onMove"]>
> | null = null;
function TestTree(props: DataViewRenderProps<unknown>): ReactElement {
  // Drawn flat (Sub-items: Flat / Parents only): the rows and the schema.
  if (!props.hierarchy) {
    return (
      <div>
        <p data-testid="fields">
          {(props.fields as FieldDef<unknown>[]).map((f) => f.id).join(",")}
        </p>
        <ul data-testid="tree">
          {(props.rows as Node[]).map((r) => (
            <li key={r.id} data-row-key={r.id}>
              {r.id}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <TestNested {...props} />;
}
function TestNested(props: DataViewRenderProps<unknown>): ReactElement {
  const primaryField = (props.fields as FieldDef<unknown>[]).find(
    (f) => f.id === "title",
  );
  const h = useHierarchyTree({ props, primaryField, options: {} });
  const model = useTreeModel({ ...h.treeArgs, rows: h.rows, search: h.search });
  // Reported up as the nested table does (`reportExpandAll`): a report is a
  // host state write, so a view whose inputs change identity on every render
  // turns it into an update loop.
  const expandAll = useMemo(() => {
    const state = flatExpandAll(model.scoped);
    return state.hasExpandable
      ? { allExpanded: state.allExpanded, changes: state.changes }
      : null;
  }, [model.scoped]);
  const report = props.reportExpandAll;
  useEffect(() => {
    // A report per render of the host is an update loop: fail it here,
    // rather than spin inside `act` forever.
    if (++reportCount > 50) {
      throw new Error(
        "TestNested: expand-all reported 50+ times — an update loop",
      );
    }
    report?.(expandAll);
  }, [report, expandAll]);
  return (
    <div>
      {h.grouped ? (
        <p data-testid="sections">
          {h.grouped.sections
            .map(
              (s) =>
                `${s.key}:${(h.grouped!.rowsBySectionKey.get(s.key!) ?? [])
                  .map((r) => r.id)
                  .join(",")}`,
            )
            .join("|")}
        </p>
      ) : null}
      {h.grouped?.sections.map((s) =>
        s.paging ? (
          <button
            key={s.key}
            aria-label={`read ${s.key}`}
            onClick={() => s.paging!.loadMore()}
          />
        ) : null,
      )}
      <button
        aria-label="move"
        onClick={() => {
          const result = h.treeArgs.onMove?.(...moveArgs!);
          // The write's rejection is the host's to surface; the test keeps it.
          if (result)
            result.then(undefined, (e: unknown) => moveErrors.push(e));
        }}
      />
      <ul data-testid="tree">
        {model.flat.map((line) =>
          line.kind === "node" ? (
            <li
              key={line.node.id}
              data-row-key={line.node.id}
              data-chevron={
                line.node.children.length > 0 ||
                (h.treeArgs.lazyChildren?.hasChildren(line.node) ?? false)
              }
            >
              {`${"-".repeat(line.depth)}${line.node.id}`}
              <button
                aria-label={`toggle ${line.node.id}`}
                onClick={() =>
                  props.setExpanded([
                    { id: line.node.id, expanded: !line.node.expanded },
                  ])
                }
              />
            </li>
          ) : (
            <li key={`ph:${line.parent.id}`}>
              {`${"-".repeat(line.depth)}[${line.placeholder.kind}]`}
              {line.placeholder.kind === "more" ? (
                <button
                  aria-label={`more ${line.parent.id}`}
                  onClick={line.placeholder.loadMore}
                />
              ) : null}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
const TREE_VIEW = {
  type: "table",
  title: "Table",
  icon: symbol("table"),
  component: TestTree,
  nestsHierarchy: true,
};

let viewState: ViewState = { sort: [], filter: null, query: "" };
let selection: string | undefined;
function publishModel() {
  const noop = () => {};
  const state = viewState;
  modelStore.set({
    ready: true,
    instances: [
      {
        instance: {
          id: "all",
          name: "All",
          icon: symbol("view-list"),
          pickedIcon: null,
          type: "table",
          source: "all",
        },
        viewType: TREE_VIEW,
      },
    ],
    activeId: "all",
    setActiveView: noop,
    stateFor: fakeViewGetter(() => state),
    setSort: noop,
    setSortRules: noop,
    setProperties: noop,
    setFilter: noop,
    setGroupBy: noop,
    setFold: noop,
    setQuery: noop,
    setExpanded: (_view: string, changes: readonly ExpandChange[]) => {
      const expanded = { ...viewState.expanded };
      for (const ch of changes) expanded[ch.id] = ch.expanded;
      viewState = { ...viewState, expanded };
      publishModel();
    },
    collapsedSectionsFor: fakeViewGetter(() => NO_COLLAPSED),
    setSectionCollapsed: noop,
    sectionFor: fakeViewGetter(() => SECTION),
    setViewCollapsed: noop,
    actions: {
      availableSources: [],
      addView: noop,
      renameView: noop,
      setViewIcon: noop,
      duplicateView: noop,
      deleteView: noop,
      reorderView: noop,
      updateView: noop,
    },
  });
}

const Sources = defineDataViewSources<Record<string, never>>();

function mount(
  c: C,
  state: ViewState,
  extra: {
    hierarchy?: LiveHierarchyConfig<Node>;
    selectedRowId?: string;
    scope?: Partial<Record<"kind", string>>;
  } = {},
) {
  viewState = state;
  selection = extra.selectedRowId;
  publishModel();
  const all = liveDataSource(c, {
    searchable: ["title"],
    surface: STORAGE_KEY,
    unscoped: { reason: "a test surface" },
  }) satisfies LiveTreeDataSource<Node>;
  const source: LiveTreeDataSource<Node> = extra.scope
    ? all.scoped({ where: extra.scope as { kind: string } })
    : all;
  function AllSource({
    render: renderBundle,
  }: {
    render: (bundle: never) => ReactElement;
  }): ReactElement {
    // The selection is the host's, re-read on every model publish.
    const selectedRowId = useSyncExternalStore(
      modelStore.subscribe,
      () => selection,
    );
    return renderBundle({
      source,
      hierarchy: extra.hierarchy,
      selectedRowId,
    } as never);
  }
  const plugin = {
    id: "data-view-live-tree-test",
    description: "live tree fixture",
    contributions: [
      Sources({
        id: "all",
        title: "All",
        icon: symbol("list"),
        component: AllSource as never,
      }),
    ],
    slots: { ...DataViewSlots, sources: Sources },
  } as unknown as LoadedPlugin;
  render(
    <PluginProvider plugins={[plugin]}>
      <DataViewSwitcher
        storageKey={STORAGE_KEY}
        sources={Sources}
        hostProps={{}}
      />
    </PluginProvider>,
  );
}

// ── reading and answering the reads ────────────────────────────────────────
type Read = { key: string; query: Record<string, unknown>; viewport: boolean };
const reads = (c: C): Read[] =>
  [...fake.mounted]
    .filter(([, count]) => count > 0)
    .map(([key]) => {
      const [k, query, viewport] = JSON.parse(key) as [
        string,
        Record<string, unknown>,
        boolean,
      ];
      return { k, key, query, viewport };
    })
    .filter((r) => r.k === c.key);
const json = (x: unknown) => JSON.stringify(x);
const rootRead = (c: C) =>
  reads(c).find((r) => r.viewport && json(r.query.where).includes('"isEmpty"'));
const childRead = (c: C, parent: string) =>
  reads(c).find(
    (r) =>
      !r.viewport &&
      r.query.where !== undefined &&
      json(r.query.where).includes(
        `"parentId","op":"eq","operand":"${parent}"`,
      ),
  );

const NO_PLACEHOLDERS = { before: [], after: [] };
const pages = (
  rows: Node[],
  extra: { canGrow?: boolean; ancestors?: Node[] } = {},
) => ({
  status: "ready",
  rows,
  exhausted: !extra.canGrow,
  canGrow: extra.canGrow ?? false,
  growing: false,
  loadMore: () => {},
  truncated: false,
  pageErrors: [],
  placeholders: NO_PLACEHOLDERS,
  ...(extra.ancestors ? { ancestors: extra.ancestors } : {}),
});
const list = (
  rows: unknown[],
  loadMore: () => void = () => {},
  canGrow = false,
) => ({
  status: "ready",
  data: rows,
  refetch: async () => {},
  canGrow,
  growing: false,
  loadMore,
});
const answer = (read: Read | undefined, result: unknown) => {
  if (!read) throw new Error("answer: no such read is mounted");
  act(() => {
    fake.results.set(read.key, result);
    fake.notify();
  });
};
const lines = () =>
  [...screen.getByTestId("tree").querySelectorAll("li")].map(
    (li) => li.textContent,
  );
const click = (label: string) =>
  act(() => screen.getByLabelText(label).click());

class InertIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeEach(() => {
  resetDeferredLoadStateForTests();
  vi.stubGlobal("IntersectionObserver", InertIntersectionObserver);
  fake.results.clear();
  fake.mounted.clear();
  moveArgs = null;
  moveErrors.length = 0;
  reportCount = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  resetDeferredLoadStateForTests();
});

const base: ViewState = { sort: [], filter: null, query: "" };

describe("DataView — a live tree in expand mode", () => {
  it("reads the roots, opens a child window per open node, and releases it on collapse", async () => {
    const c = nodes();
    mount(c, base);
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    expect(reads(c).filter((r) => r.viewport)).toHaveLength(1);
    answer(rootRead(c), pages([row("a", null, "a0", 2), row("b", null, "a1")]));
    await waitFor(() => expect(lines()).toEqual(["a", "b"]));
    expect(childRead(c, "a")).toBeUndefined();

    click("toggle a");
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
    expect(childRead(c, "a")!.query.orderBy).toEqual([["rank", "asc"]]);
    expect(lines()).toEqual(["a", "-[loading]", "b"]);
    answer(
      childRead(c, "a"),
      list([row("a1", "a", "a0"), row("a2", "a", "a1")]),
    );
    await waitFor(() => expect(lines()).toEqual(["a", "-a1", "-a2", "b"]));

    click("toggle a");
    await waitFor(() => expect(childRead(c, "a")).toBeUndefined());
    expect(lines()).toEqual(["a", "b"]);
  });

  it("a partial level draws Load more after its loaded children, and grows that level", async () => {
    const c = nodes();
    mount(c, { ...base, expanded: { a: true } });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("a", null, "a0", 300)]));
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
    const loadMore = vi.fn();
    answer(childRead(c, "a"), list([row("a1", "a", "a0")], loadMore, true));
    await waitFor(() => expect(lines()).toEqual(["a", "-a1", "-[more]"]));
    click("more a");
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("orders every level by [sort…, rank] and draws siblings in window order", async () => {
    const c = nodes();
    mount(c, {
      ...base,
      sort: [{ fieldId: "title", direction: "desc" }],
      expanded: { a: true },
    });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    expect(rootRead(c)!.query.orderBy).toEqual([
      ["title", "desc"],
      ["rank", "asc"],
    ]);
    answer(rootRead(c), pages([row("a", null, "a0", 2)]));
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
    expect(childRead(c, "a")!.query.orderBy).toEqual([
      ["title", "desc"],
      ["rank", "asc"],
    ]);
    // The server's order, whatever the ranks say.
    answer(
      childRead(c, "a"),
      list([row("a9", "a", "a0"), row("a1", "a", "a5")]),
    );
    await waitFor(() => expect(lines()).toEqual(["a", "-a9", "-a1"]));
  });

  it("groups the roots as server sections; children follow their root", async () => {
    const c = nodes();
    mount(c, {
      ...base,
      groupBy: { fieldId: "kind", groupingId: "value" },
      expanded: { r1: true },
    });
    const groups = () => reads(c).find((r) => r.query.groupBy === "kind");
    await waitFor(() => expect(groups()).toBeDefined());
    expect(json(groups()!.query.where)).toContain('"isEmpty"');
    answer(
      groups(),
      list([
        { value: "x", count: 1 },
        { value: "y", count: 1 },
      ]),
    );
    await waitFor(() => screen.getByLabelText("read x"));
    click("read x");
    const sectionRead = () =>
      reads(c).find(
        (r) => r.viewport && json(r.query.where).includes('"operand":"x"'),
      );
    await waitFor(() => expect(sectionRead()).toBeDefined());
    answer(sectionRead(), pages([row("r1", null, "a0", 1, "x")]));
    await waitFor(() => expect(childRead(c, "r1")).toBeDefined());
    answer(childRead(c, "r1"), list([row("c1", "r1", "a0", 0, "y")]));
    await waitFor(() =>
      expect(screen.getByTestId("sections").textContent).toBe("x:r1,c1|y:"),
    );
  });

  it("reads a selected row no window holds with its path, and pins it in", async () => {
    const c = nodes();
    mount(c, base, { selectedRowId: "deep" });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("r", null, "a0", 2), row("s", null, "a1")]));
    const pathRead = () => reads(c).find((r) => r.query.id === "deep");
    await waitFor(() => expect(pathRead()).toBeDefined());
    expect(pathRead()!.query.include).toBe("ancestors");
    answer(pathRead(), {
      status: "ready",
      found: true,
      row: row("deep", "mid", "a0"),
      ancestors: [row("r", null, "a0", 2), row("mid", "r", "a5", 1)],
      refetch: async () => {},
    });
    // Revealed: its ancestors open, the path drawn among the loaded siblings.
    await waitFor(() => expect(childRead(c, "r")).toBeDefined());
    answer(
      childRead(c, "r"),
      list([row("m0", "r", "a0"), row("m9", "r", "a9")]),
    );
    await waitFor(() =>
      expect(lines()).toEqual(["r", "-m0", "-mid", "--deep", "-m9", "s"]),
    );
  });

  it("draws a reparent in flight at its destination until the moved row's live read says it is there", async () => {
    const c = nodes();
    let settle!: () => void;
    const onMove = vi.fn(
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    mount(
      c,
      { ...base, expanded: { a: true, b: true } },
      { hierarchy: { onMove } },
    );
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(
      rootRead(c),
      pages([row("a", null, "a0", 1), row("b", null, "a1", 1)]),
    );
    await waitFor(() => expect(childRead(c, "b")).toBeDefined());
    answer(childRead(c, "a"), list([row("a1", "a", "a0")]));
    answer(childRead(c, "b"), list([row("b1", "b", "a0")]));
    await waitFor(() => expect(lines()).toEqual(["a", "-a1", "b", "-b1"]));

    moveArgs = ["a1", { parentId: "b", targetId: "b1", zone: "before" }];
    click("move");
    expect(onMove).toHaveBeenCalledWith("a1", moveArgs[1]);
    const movedRead = () => reads(c).find((r) => r.query.id === "a1");
    await waitFor(() => expect(movedRead()).toBeDefined());
    // Drawn at its destination at once, out of its source.
    expect(lines()).toEqual(["a", "-[empty]", "b", "-a1", "-b1"]);
    // The row read still says the old parent, the source window lets it go:
    // still drawn where it went.
    answer(movedRead(), {
      status: "ready",
      found: true,
      row: row("a1", "a", "a0"),
      refetch: async () => {},
    });
    answer(childRead(c, "a"), list([]));
    expect(lines()).toEqual(["a", "-[empty]", "b", "-a1", "-b1"]);
    // The row read says it is under `b`: settled — past `b`'s loaded prefix
    // it is simply not drawn (no ghost pinned from a stale copy).
    answer(movedRead(), {
      status: "ready",
      found: true,
      row: row("a1", "b", "a9"),
      refetch: async () => {},
    });
    await waitFor(() => expect(lines()).toEqual(["a", "-[empty]", "b", "-b1"]));
    await waitFor(() => expect(movedRead()).toBeUndefined());
    await act(async () => settle());
  });

  it("a rejected move goes back where it was", async () => {
    const c = nodes();
    let fail!: (e: Error) => void;
    const onMove = vi.fn(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    );
    mount(c, { ...base, expanded: { a: true } }, { hierarchy: { onMove } });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("a", null, "a0", 1), row("b", null, "a1")]));
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
    answer(childRead(c, "a"), list([row("a1", "a", "a0")]));
    await waitFor(() => expect(lines()).toEqual(["a", "-a1", "b"]));
    moveArgs = ["a1", { parentId: null, targetId: "b", zone: "after" }];
    click("move");
    await waitFor(() => expect(lines()).toEqual(["a", "-[empty]", "b", "a1"]));
    await act(async () => fail(new Error("refused")));
    await waitFor(() => expect(lines()).toEqual(["a", "-a1", "b"]));
    expect(moveErrors).toHaveLength(1);
  });

  it("a failed reveal is a notice with Retry beside a healthy tree", async () => {
    const c = nodes();
    mount(c, base, { selectedRowId: "deep" });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("r", null, "a0", 2)]));
    const pathRead = () => reads(c).find((r) => r.query.id === "deep");
    await waitFor(() => expect(pathRead()).toBeDefined());
    answer(pathRead(), {
      status: "error",
      error: Object.assign(new Error("path read failed"), { kind: "network" }),
      refetch: async () => {},
    });
    await waitFor(() => screen.getByText(/path read failed/));
    expect(screen.getAllByText("Retry").length).toBeGreaterThan(0);
    expect(lines()).toEqual(["r"]);
  });

  it("pins a path only while its read is live: selecting another row unpins it", async () => {
    const c = nodes();
    mount(c, base, { selectedRowId: "deep" });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("r", null, "a0", 1), row("s", null, "a1")]));
    const pathRead = () => reads(c).find((r) => r.query.id === "deep");
    await waitFor(() => expect(pathRead()).toBeDefined());
    answer(pathRead(), {
      status: "ready",
      found: true,
      row: row("deep", "r", "a0"),
      ancestors: [row("r", null, "a0", 1)],
      refetch: async () => {},
    });
    await waitFor(() => expect(lines()).toContain("-deep"));
    act(() => {
      selection = "s";
      publishModel();
    });
    await waitFor(() => expect(pathRead()).toBeUndefined());
    // `r` stays open (the reveal opened it), but nothing backs `deep` now.
    await waitFor(() => expect(lines()).not.toContain("-deep"));
  });

  it("does not read a selected row's path while an open level that may hold it is loading", async () => {
    const c = nodes();
    mount(c, { ...base, expanded: { r: true } }, { selectedRowId: "kid" });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("r", null, "a0", 1)]));
    await waitFor(() => expect(childRead(c, "r")).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads(c).find((r) => r.query.id === "kid")).toBeUndefined();
    answer(childRead(c, "r"), list([row("kid", "r", "a0")]));
    await waitFor(() => expect(lines()).toEqual(["r", "-kid"]));
    expect(reads(c).find((r) => r.query.id === "kid")).toBeUndefined();
  });

  it("a scope narrows the roots only: a subtree under a drawn root is whole", async () => {
    const c = nodes();
    mount(c, { ...base, expanded: { r: true } }, { scope: { kind: "x" } });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    const rootWhere = json(rootRead(c)!.query.where);
    expect(rootWhere).toContain('"isEmpty"');
    expect(rootWhere).toContain('"kind"');
    answer(rootRead(c), pages([row("r", null, "a0", 1, "x")]));
    await waitFor(() => expect(childRead(c, "r")).toBeDefined());
    // The level reads every child — its count is what the chevron promised.
    expect(json(childRead(c, "r")!.query.where)).not.toContain('"kind"');
    answer(childRead(c, "r"), list([row("k", "r", "a0", 0, "y")]));
    await waitFor(() => expect(lines()).toEqual(["r", "-k"]));
  });
});

describe("DataView — a live tree's aliases", () => {
  // The reference edges, one row per parent: a lookup-only collection.
  const edgesOf = () =>
    liveCollection(`test.data-view.live-tree-edges-${n++}`, {
      carry: { fields: { id: textField(), linksTo: stringListField() } },
      id: "id",
    });
  const edgeReads = (key: string) =>
    [...fake.mounted]
      .filter(([, count]) => count > 0)
      .map(([k]) => JSON.parse(k) as [string, { ids?: string[] }, boolean])
      .filter(([k, q]) => k === key && q.ids !== undefined)
      .map(([, q]) => q.ids!);

  it("reads the held rows' edges by id, per level, and draws an open node's targets as references", async () => {
    const c = nodes();
    const edges = edgesOf();
    mount(c, base, {
      hierarchy: {
        aliases: treeAliases({ collection: edges, targets: (e) => e.linksTo }),
      },
    });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    // Nothing read before a window holds rows.
    expect(edgeReads(edges.key)).toEqual([]);
    answer(rootRead(c), pages([row("a", null, "a0", 1), row("b", null, "a1")]));
    await waitFor(() => expect(edgeReads(edges.key)).toEqual([["a", "b"]]));
    // No chevron on b until its edges answer.
    expect(
      screen.getByText("b").closest("li")!.getAttribute("data-chevron"),
    ).toBe("false");
    const edgeKey = fake.keyOf(edges, { ids: ["a", "b"] }, undefined);
    act(() => {
      fake.results.set(edgeKey, list([{ id: "b", linksTo: ["x"] }]));
      fake.notify();
    });
    await waitFor(() =>
      expect(
        screen.getByText("b").closest("li")!.getAttribute("data-chevron"),
      ).toBe("true"),
    );

    // Opening b reads its target, which no window holds, by id — and a's
    // level read adds one edge read of its own rows.
    click("toggle b");
    const targetRead = () =>
      reads(c).find((r) => json(r.query.ids) === json(["x"]));
    await waitFor(() => expect(targetRead()).toBeDefined());
    answer(targetRead(), list([row("x", "elsewhere", "a0")]));
    // Drawn as the alias (its projected id), never as a row of its own.
    await waitFor(() =>
      expect(lines()).toEqual(["a", "b", `-${aliasNodeId("x", "b")}`]),
    );

    click("toggle a");
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
    answer(childRead(c, "a"), list([row("a1", "a", "a0")]));
    await waitFor(() =>
      expect(edgeReads(edges.key)).toEqual([["a", "b"], ["a1"]]),
    );
    // The roots' answer is kept while a's level is read: b's reference stays.
    expect(lines()).toEqual(["a", "-a1", "b", `-${aliasNodeId("x", "b")}`]);

    // Collapsing a releases its level's edge read.
    click("toggle a");
    await waitFor(() => expect(edgeReads(edges.key)).toEqual([["a", "b"]]));
  });
});

describe("DataView — a live tree in hits mode", () => {
  it("a search reads the matches with their ancestors, drawn open, and no child window", async () => {
    const c = nodes();
    mount(c, base);
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("p", null, "a0", 1)]));
    await waitFor(() => expect(lines()).toEqual(["p"]));

    viewState = { ...viewState, query: "hit" };
    publishModel();
    const hitsRead = () =>
      reads(c).find((r) => r.viewport && json(r.query.where).includes("hit"));
    await waitFor(() => expect(hitsRead()).toBeDefined(), { timeout: 1000 });
    expect(hitsRead()!.query.include).toBe("ancestors");
    expect(rootRead(c)).toBeUndefined();
    answer(
      hitsRead(),
      pages([row("hit", "mid", "a0")], {
        ancestors: [row("p", null, "a0", 1), row("mid", "p", "a0", 1)],
      }),
    );
    await waitFor(() => expect(lines()).toEqual(["p", "-mid", "--hit"]));
    expect(reads(c).filter((r) => !r.viewport && r.query.where)).toEqual([]);
  });

  it("a hit whose ancestors have not answered is pending — held, never drawn as a root — then joins its chain", async () => {
    const c = nodes();
    mount(c, { ...base, query: "hit" });
    const hitsRead = () =>
      reads(c).find((r) => r.viewport && json(r.query.where).includes("hit"));
    await waitFor(() => expect(hitsRead()).toBeDefined(), { timeout: 1000 });
    answer(hitsRead(), {
      ...pages([row("top", null, "a0"), row("hit", "p", "a1")], {
        ancestors: [],
      }),
      ancestorsPending: true,
    });
    await waitFor(() => expect(lines()).toEqual(["top"]));
    answer(hitsRead(), {
      ...pages([row("top", null, "a0"), row("hit", "p", "a1")], {
        ancestors: [row("p", null, "a1", 1)],
      }),
      ancestorsPending: false,
    });
    await waitFor(() => expect(lines()).toEqual(["top", "p", "-hit"]));
  });

  it("once every ancestor answered, a hit with no parent in the collection is drawn as a root", async () => {
    const c = nodes();
    mount(c, { ...base, query: "hit" });
    const hitsRead = () =>
      reads(c).find((r) => r.viewport && json(r.query.where).includes("hit"));
    await waitFor(() => expect(hitsRead()).toBeDefined(), { timeout: 1000 });
    answer(hitsRead(), {
      ...pages([row("hit", "gone", "a0")], { ancestors: [] }),
      ancestorsPending: false,
    });
    await waitFor(() => expect(lines()).toEqual(["hit"]));
  });

  it("hits mode grouped and sorted settles (no update loop)", async () => {
    const c = nodes();
    const errors = vi.spyOn(console, "error");
    mount(c, {
      ...base,
      query: "hit",
      sort: [{ fieldId: "title", direction: "desc" }],
      groupBy: { fieldId: "kind", groupingId: "value" },
    });
    const hitsRead = () =>
      reads(c).find((r) => r.viewport && json(r.query.where).includes("hit"));
    await waitFor(() => expect(hitsRead()).toBeDefined(), { timeout: 1000 });
    answer(
      hitsRead(),
      pages([row("hit", "p", "a0", 0, "x"), row("hit2", null, "a1", 0, "y")], {
        ancestors: [row("p", null, "a0", 1, "x")],
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sections").textContent).toBe("x:hit,p|y:hit2"),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      errors.mock.calls.filter((c) => String(c[0]).includes("Maximum update")),
    ).toEqual([]);
    errors.mockRestore();
  });

  it("draws a chevron only on a node with drawn children, never from its child count", async () => {
    const c = nodes();
    mount(c, { ...base, query: "hit" });
    const hitsRead = () =>
      reads(c).find((r) => r.viewport && json(r.query.where).includes("hit"));
    await waitFor(() => expect(hitsRead()).toBeDefined(), { timeout: 1000 });
    answer(
      hitsRead(),
      pages([row("hit", "p", "a0", 5)], {
        ancestors: [row("p", null, "a0", 3)],
      }),
    );
    await waitFor(() => expect(lines()).toEqual(["p", "-hit"]));
    const chevron = (id: string) =>
      screen
        .getByTestId("tree")
        .querySelector(`[data-row-key="${id}"]`)!
        .getAttribute("data-chevron");
    expect(chevron("p")).toBe("true");
    expect(chevron("hit")).toBe("false");
  });

  it("the scope keeps the hits under an in-scope root", async () => {
    const c = nodes();
    mount(c, { ...base, query: "hit" }, { scope: { kind: "x" } });
    const hitsRead = () =>
      reads(c).find((r) => r.viewport && json(r.query.where).includes("hit"));
    await waitFor(() => expect(hitsRead()).toBeDefined(), { timeout: 1000 });
    // The hits are read whatever their own columns say…
    expect(json(hitsRead()!.query.where)).not.toContain('"kind"');
    answer(
      hitsRead(),
      pages(
        [row("hit1", "in", "a0", 0, "z"), row("hit2", "out", "a1", 0, "x")],
        {
          ancestors: [
            row("in", null, "a0", 1, "x"),
            row("out", null, "a1", 1, "y"),
          ],
        },
      ),
    );
    // …and kept under a root the scope admits.
    await waitFor(() => expect(lines()).toEqual(["in", "-hit1"]));
  });

  it("flipping to hits releases every child window; back to expand reads them again", async () => {
    const c = nodes();
    mount(c, { ...base, expanded: { a: true } });
    await waitFor(() => expect(rootRead(c)).toBeDefined());
    answer(rootRead(c), pages([row("a", null, "a0", 1)]));
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
    act(() => {
      viewState = { ...viewState, query: "zzz" };
      publishModel();
    });
    await waitFor(() => expect(childRead(c, "a")).toBeUndefined(), {
      timeout: 1000,
    });
    act(() => {
      viewState = { ...viewState, query: "" };
      publishModel();
    });
    await waitFor(() => expect(rootRead(c)).toBeDefined(), { timeout: 1000 });
    await waitFor(() => expect(childRead(c, "a")).toBeDefined());
  });
});

describe("DataView — a live tree drawn flat", () => {
  it("adds the Parent field, read per row on screen", async () => {
    const c = nodes();
    mount(c, { ...base, nesting: "flat" });
    const flatRead = () => reads(c).find((r) => r.viewport);
    await waitFor(() => expect(flatRead()).toBeDefined());
    // The ordinary flat source: no `parent isEmpty`.
    expect(json(flatRead()!.query.where ?? null)).not.toContain('"isEmpty"');
    answer(flatRead(), pages([row("a", null, "a0", 1), row("a1", "a", "a0")]));
    await waitFor(() =>
      expect(screen.getByTestId("fields").textContent).toContain("parent"),
    );
  });
});

describe("rowRead over a collection row", () => {
  it("reads the on-screen rows' ids in one { ids } read and hands each cell its row", async () => {
    const c = nodes();
    const parentField = withRowReadCells(
      withLiveParentField<Node>(
        [{ id: "title", label: "Title", primary: true, value: (r) => r.title }],
        c as unknown as LiveCollection<unknown, unknown, string>,
        { parent: "parentId", rank: "rank" },
      ),
    ).find((f) => f.id === "parent")!;
    const rowsShown = [
      row("a1", "a", "a0"),
      row("b1", "b", "a0"),
      row("r", null, "a0"),
    ];
    render(
      <PluginProvider plugins={[]}>
        <RowReadsHost
          fields={[parentField] as FieldDef<unknown>[]}
          rows={rowsShown}
          rowKey={(r) => (r as Node).id}
          onScreen={new Set(["a1", "b1", "r"])}
        >
          <ul data-testid="cells">
            {rowsShown.map((r) => (
              <li key={r.id}>{parentField.cell!(r)}</li>
            ))}
          </ul>
        </RowReadsHost>
      </PluginProvider>,
    );
    const idsRead = () => reads(c).find((r) => r.query.ids !== undefined);
    await waitFor(() => expect(idsRead()).toBeDefined());
    // One read, the parents' ids — a root reads none.
    expect(idsRead()!.query.ids).toEqual(["a", "b"]);
    answer(idsRead(), {
      status: "ready",
      data: [row("a", null, "a0"), row("b", null, "a1")],
      refetch: async () => {},
    });
    await waitFor(() =>
      expect(
        [...screen.getByTestId("cells").querySelectorAll("li")].map(
          (li) => li.textContent,
        ),
      ).toEqual(["a", "b", ""]),
    );
  });
});
