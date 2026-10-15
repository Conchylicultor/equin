import { symbol } from "@plugins/ui/plugins/icons/core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { useViewsConfig } from "../internal/use-views-config";
import type { ViewConfigRow, ViewSourceEntry, ViewTypeMeta } from "../../core";

// The engine reads rows off `useConfigResult(descriptor)` — the readiness-carrying
// read — and persists via `useSetConfig(descriptor)(key, value)`. Mock both:
// `useConfigResult` returns a fixed settled result (so the reconcile effect's JSON
// identity stays stable and the optimistic mirror is the source of truth for
// assertions), `useSetConfig` a spy. `configPending` flips it to the not-yet-known
// arm, which is what the loading tests exercise.
const setConfigSpy = vi.fn();
let configDoc: { views: unknown[] } = { views: [] };
let configPending = false;
let configFailure: Error | null = null;
vi.mock("@plugins/config_v2/web", () => ({
  useConfigResult: () =>
    configFailure !== null
      ? {
          status: "error",
          error: configFailure,
          refetch: async () => {},
        }
      : configPending
        ? {
            status: "loading",
            refetch: async () => {},
          }
        : {
            status: "ready",
            data: configDoc,
            refetch: async () => {},
          },
  useSetConfig: () => setConfigSpy,
}));

const viewIcon = symbol("view-list");

// Minimal view-type contributions so `buildInstanceFromRow` resolves each row.
const contributions = [
  { type: "table", title: "Table", icon: viewIcon },
  { type: "gallery", title: "Gallery", icon: viewIcon },
] as unknown as SealContributions<ViewTypeMeta>[];

// The implicit sole source — the single-source case every existing DataView is.
const singleSource: ViewSourceEntry<ViewTypeMeta>[] = [{ contributions }];

// A multi-source entry list (named sources) plus the implicit one.
const multiSource: ViewSourceEntry<ViewTypeMeta>[] = [
  { contributions },
  { id: "queue", title: "Queue", contributions },
];

const descriptorMap = new Map<string, ConfigDescriptor>([
  ["k", {} as ConfigDescriptor],
]);

beforeEach(() => {
  setConfigSpy.mockClear();
  configPending = false;
});

function renderViews(
  views: unknown[],
  entries: ViewSourceEntry<ViewTypeMeta>[] = singleSource,
) {
  configDoc = { views };
  return renderHook(() =>
    useViewsConfig<ViewTypeMeta>("k", descriptorMap, entries),
  );
}

function ids(result: { current: ReturnType<typeof useViewsConfig> }): string[] {
  return result.current.instances.map((i) => i.instance.id);
}

/** The last persisted `views` rows (flushed on unmount). */
function flushedRows(unmount: () => void): ViewConfigRow[] {
  unmount();
  const last = setConfigSpy.mock.calls.at(-1);
  expect(last?.[0]).toBe("views");
  return last?.[1] as ViewConfigRow[];
}

describe("useViewsConfig — array-order (no rank)", () => {
  it("renders rows in authored array order", () => {
    const { result } = renderViews([
      { id: "a", name: "A", view: { type: "table" } },
      { id: "b", name: "B", view: { type: "table" } },
      { id: "c", name: "C", view: { type: "table" } },
    ]);
    expect(ids(result)).toEqual(["a", "b", "c"]);
  });

  it("reorderView moves a row down by array splice", () => {
    const { result } = renderViews([
      { id: "a", name: "A", view: { type: "table" } },
      { id: "b", name: "B", view: { type: "table" } },
      { id: "c", name: "C", view: { type: "table" } },
      { id: "d", name: "D", view: { type: "table" } },
    ]);
    // Move A (index 0) to index 2 → lands after C.
    act(() => result.current.reorderView("a", 2));
    expect(ids(result)).toEqual(["b", "c", "a", "d"]);
  });

  it("reorderView moves a row up by array splice", () => {
    const { result } = renderViews([
      { id: "a", name: "A", view: { type: "table" } },
      { id: "b", name: "B", view: { type: "table" } },
      { id: "c", name: "C", view: { type: "table" } },
      { id: "d", name: "D", view: { type: "table" } },
    ]);
    // Move D (index 3) to index 1.
    act(() => result.current.reorderView("d", 1));
    expect(ids(result)).toEqual(["a", "d", "b", "c"]);
  });

  it("addView appends to the end", () => {
    const { result } = renderViews([
      { id: "a", name: "A", view: { type: "table" } },
    ]);
    let newIdReturned = "";
    act(() => {
      newIdReturned = result.current.addView("gallery");
    });
    const order = ids(result);
    expect(order).toHaveLength(2);
    expect(order[0]).toBe("a");
    expect(order[1]).toBe(newIdReturned);
  });

  it("duplicateView inserts the clone immediately after the source", () => {
    const { result } = renderViews([
      { id: "a", name: "A", view: { type: "table" } },
      { id: "b", name: "B", view: { type: "table" } },
      { id: "c", name: "C", view: { type: "table" } },
    ]);
    let cloneId = "";
    act(() => {
      cloneId = result.current.duplicateView("b");
    });
    const order = ids(result);
    // Clone lands directly after "b".
    expect(order).toEqual(["a", "b", cloneId, "c"]);
  });
});

describe("useViewsConfig — mergeView key omission (Part B)", () => {
  it("drops keys whose merged value is undefined instead of persisting them", () => {
    const { result } = renderViews([
      {
        id: "a",
        name: "A",
        view: { type: "table", sort: [{ fieldId: "x", direction: "asc" }] },
      },
    ]);
    // A host clears the sort by passing `sort: undefined`.
    act(() => {
      result.current.updateView(
        "a",
        { sort: undefined } as unknown as VariantValue,
        { merge: true },
      );
    });
    const view = result.current.viewFor("a");
    expect(view).toBeDefined();
    // The key is GONE — not persisted as `sort: []` / `sort: null` / `sort: undefined`.
    expect(view && "sort" in view).toBe(false);
    // Other keys survive the merge.
    expect(view?.type).toBe("table");
  });
});

describe("useViewsConfig — source preservation through every mutator", () => {
  const mixedRows = [
    { id: "q", name: "Queue", view: { type: "table" }, source: "queue" },
    { id: "a", name: "All", view: { type: "table" } },
  ];

  it("resolves sourceful rows through their entry and carries source on instances", () => {
    const { result } = renderViews(mixedRows, multiSource);
    expect(ids(result)).toEqual(["q", "a"]);
    expect(result.current.instances[0]!.instance.source).toBe("queue");
    expect("source" in result.current.instances[1]!.instance).toBe(false);
  });

  it("renameView preserves source AND leaves source-less rows bare on write", () => {
    const { result, unmount } = renderViews(mixedRows, multiSource);
    act(() => {
      result.current.renameView("q", "Q2");
      result.current.renameView("a", "A2");
    });
    const rows = flushedRows(unmount);
    expect(rows[0]!.source).toBe("queue");
    // Byte-identity: the source-less row must not gain a `source` key.
    expect("source" in rows[1]!).toBe(false);
  });

  it("reorderView preserves source", () => {
    const { result, unmount } = renderViews(mixedRows, multiSource);
    act(() => result.current.reorderView("q", 1));
    const rows = flushedRows(unmount);
    expect(rows.map((r) => r.id)).toEqual(["a", "q"]);
    expect(rows[1]!.source).toBe("queue");
    expect("source" in rows[0]!).toBe(false);
  });

  it("deleteView keeps the surviving row's source intact", () => {
    const { result, unmount } = renderViews(mixedRows, multiSource);
    act(() => result.current.deleteView("a"));
    const rows = flushedRows(unmount);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("queue");
  });

  it("duplicateView copies source explicitly (and stays bare for bare rows)", () => {
    const { result, unmount } = renderViews(mixedRows, multiSource);
    act(() => {
      result.current.duplicateView("q");
      result.current.duplicateView("a");
    });
    const rows = flushedRows(unmount);
    expect(rows).toHaveLength(4);
    expect(rows[1]!.source).toBe("queue"); // clone of q
    expect("source" in rows[3]!).toBe(false); // clone of a
  });

  it("updateView (merge) preserves source", () => {
    const { result, unmount } = renderViews(mixedRows, multiSource);
    act(() => {
      result.current.updateView(
        "q",
        {
          sort: [{ fieldId: "x", direction: "asc" }],
        } as unknown as VariantValue,
        { merge: true },
      );
    });
    const rows = flushedRows(unmount);
    expect(rows[0]!.source).toBe("queue");
  });

  it("addView(type, sourceId) stamps source on the seed row; without sourceId it stays bare", () => {
    const { result, unmount } = renderViews([], multiSource);
    let sourcefulId = "";
    let bareId = "";
    act(() => {
      sourcefulId = result.current.addView("table", "queue");
    });
    act(() => {
      bareId = result.current.addView("gallery");
    });
    const rows = flushedRows(unmount);
    expect(rows.map((r) => r.id)).toEqual([sourcefulId, bareId]);
    expect(rows[0]!.source).toBe("queue");
    expect(rows[0]!.name).toBe("Table"); // seed title from the source's contributions
    expect("source" in rows[1]!).toBe(false);
  });
});

describe("useViewsConfig — loading is not empty", () => {
  it("reports ready:false while the config document is unknown", () => {
    configPending = true;
    configDoc = { views: [] };
    const { result } = renderHook(() =>
      useViewsConfig<ViewTypeMeta>("k", descriptorMap, singleSource),
    );
    // Zero instances AND not ready: the host must render a loading state, not
    // "No views configured" — the two are indistinguishable from the row list
    // alone, which is exactly the bug this flag exists to prevent.
    expect(result.current.ready).toBe(false);
    expect(result.current.instances).toEqual([]);
  });

  it("reports a failure (not endless loading) when the document cannot load", () => {
    configFailure = new Error("boom");
    try {
      const { result } = renderHook(() =>
        useViewsConfig<ViewTypeMeta>("k", descriptorMap, singleSource),
      );
      expect(result.current.ready).toBe(false);
      expect(result.current.failure?.error).toBe(configFailure);
    } finally {
      configFailure = null;
    }
  });

  it("reports ready:true for a settled, genuinely empty config", () => {
    const { result } = renderViews([]);
    expect(result.current.ready).toBe(true);
    expect(result.current.instances).toEqual([]);
  });

  it("reports ready:true once rows have arrived", () => {
    const { result } = renderViews([
      { id: "a", name: "A", view: { type: "table" } },
    ]);
    expect(result.current.ready).toBe(true);
    expect(ids(result)).toEqual(["a"]);
  });
});
