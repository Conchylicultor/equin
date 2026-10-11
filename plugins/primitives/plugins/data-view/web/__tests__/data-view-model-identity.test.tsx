import { useCallback, useMemo, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import type { DataViewId } from "../../core";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";
import { useDataViewModel } from "../internal/use-data-view-model";

// The model's per-view getters must hand back the SAME object for a view until
// that view's own inputs change — consumers memoise on them, and a render-phase
// `setState` keyed on identity loops otherwise (React #301). view-core's engine
// is faked here with a raw `view` value per id that keeps its identity until an
// `updateView` to that id replaces it (what the real mirror guarantees, pinned
// by `shareRows`' own test).
vi.mock(
  "@plugins/primitives/plugins/data-view/plugins/view-core/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useViewModel: () => useFakeCore(),
  }),
);

let initialViews: Record<string, VariantValue> = {};

const NO_VARIANTS = new Map<string, never>();

const ACTIONS = {
  availableSources: [],
  variantsFor: fakeViewGetter(() => NO_VARIANTS),
  addView: () => {},
  renameView: () => {},
  setViewIcon: () => {},
  duplicateView: () => {},
  deleteView: () => {},
  reorderView: () => {},
  updateView: () => {},
};

function useFakeCore() {
  const [views, setViews] = useState(initialViews);
  const viewFor = useCallback(
    (id: string): VariantValue | undefined => views[id],
    [views],
  );
  const updateView = useCallback(
    (id: string, patch: VariantValue) =>
      setViews((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } })),
    [],
  );
  return useMemo(
    () => ({
      ready: true,
      failure: null,
      instances: [],
      activeId: "a",
      setActiveView: () => {},
      viewFor,
      updateView,
      actions: ACTIONS,
      availableSources: [],
    }),
    [viewFor, updateView],
  );
}

const STORAGE_KEY = "test.model-identity" as DataViewId;

function renderModel() {
  return renderHook(() => {
    const model = useDataViewModel(STORAGE_KEY, [], undefined);
    if (!model.ready) throw new Error("fake core is always ready");
    return model;
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  initialViews = {
    a: { type: "list", groupBy: "status" },
    b: { type: "list" },
  };
});

describe("useDataViewModel — getter identity", () => {
  it("returns the same objects across a rerender", () => {
    const { result, rerender } = renderModel();
    const state = result.current.stateFor("a");
    const section = result.current.sectionFor("a");
    const collapsed = result.current.collapsedSectionsFor("a");
    rerender();
    expect(result.current.stateFor("a")).toBe(state);
    expect(result.current.sectionFor("a")).toBe(section);
    expect(result.current.collapsedSectionsFor("a")).toBe(collapsed);
  });

  it("keeps a legacy string groupBy's migrated rule stable", () => {
    const { result, rerender } = renderModel();
    const groupBy = result.current.stateFor("a").groupBy;
    expect(groupBy).toEqual({ fieldId: "status", groupingId: "value" });
    rerender();
    expect(result.current.stateFor("a").groupBy).toBe(groupBy);
  });

  it("leaves view a untouched by writes to view b", () => {
    const { result } = renderModel();
    const state = result.current.stateFor("a");
    const section = result.current.sectionFor("a");
    const collapsed = result.current.collapsedSectionsFor("a");
    const stateB = result.current.stateFor("b");

    act(() => result.current.setQuery("b", "x"));
    act(() => result.current.setSort("b", "name"));
    act(() => result.current.setSectionCollapsed("b", "done", true));
    act(() => result.current.setViewCollapsed("b", true));

    expect(result.current.stateFor("a")).toBe(state);
    expect(result.current.sectionFor("a")).toBe(section);
    expect(result.current.collapsedSectionsFor("a")).toBe(collapsed);
    expect(result.current.stateFor("b")).not.toBe(stateB);
    expect(result.current.stateFor("b").query).toBe("x");
    expect(result.current.collapsedSectionsFor("b").has("done")).toBe(true);
    expect(result.current.sectionFor("b").collapsed).toBe(true);
  });

  it("re-derives only the getters whose inputs a write to the view changed", () => {
    const { result } = renderModel();
    const state = result.current.stateFor("a");
    const section = result.current.sectionFor("a");
    const collapsed = result.current.collapsedSectionsFor("a");

    // A section collapse touches neither the view's state nor its presentation.
    act(() => result.current.setSectionCollapsed("a", "done", true));
    expect(result.current.stateFor("a")).toBe(state);
    expect(result.current.sectionFor("a")).toBe(section);
    const collapsedAfter = result.current.collapsedSectionsFor("a");
    expect(collapsedAfter).not.toBe(collapsed);
    expect(collapsedAfter.has("done")).toBe(true);

    // A query changes the state only.
    act(() => result.current.setQuery("a", "q"));
    const stateAfter = result.current.stateFor("a");
    expect(stateAfter).not.toBe(state);
    expect(stateAfter.query).toBe("q");
    expect(result.current.sectionFor("a")).toBe(section);
    expect(result.current.collapsedSectionsFor("a")).toBe(collapsedAfter);
  });
});
