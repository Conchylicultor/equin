import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";
import type { DataViewId } from "../../core";
import { useDataViewModel } from "../internal/use-data-view-model";

// Under drafts, switching views discards the view being left's working copy
// and offers it back with an Undo toast. view-core's engine is faked: its
// drafts are spies, `setActiveView` records the selection.
const toasts: {
  description?: string;
  action?: { label: string; onClick: () => void };
}[] = [];
vi.mock("@plugins/shell/plugins/toast/web", () => ({
  showToast: (args: (typeof toasts)[number]) => toasts.push(args),
}));

const COPY = { type: "map", sort: [1] } as VariantValue;
let pendingCopy: VariantValue | null = COPY;
const discard = vi.fn((_id: string) => {
  const copy = pendingCopy;
  pendingCopy = null;
  return copy;
});
const restore = vi.fn();
const selected: string[] = [];
let activeId = "all";

const instance = (id: string, name: string) => ({
  instance: { id, name, type: "map", pickedIcon: null, icon: () => null },
  viewType: { type: "map" },
});

vi.mock(
  "@plugins/primitives/plugins/data-view/plugins/view-core/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useViewModel: () => ({
      ready: true,
      failure: null,
      instances: [instance("all", "All places"), instance("food", "Food")],
      activeId,
      setActiveView: (id: string) => {
        selected.push(id);
        activeId = id;
      },
      viewFor: () => undefined,
      savedViewFor: () => undefined,
      dirtyFor: fakeViewGetter(() => false),
      updateView: () => {},
      drafts: {
        save: () => {},
        discard,
        restore,
        saveAsNew: () => "new",
      },
      actions: {
        availableSources: [],
        variantsFor: fakeViewGetter(() => new Map()),
        addView: () => {},
        renameView: () => {},
        setViewIcon: () => {},
        duplicateView: () => {},
        deleteView: () => {},
        reorderView: () => {},
        updateView: () => {},
      },
      availableSources: [],
    }),
  }),
);

const STORAGE_KEY = "test.drafts-switch" as DataViewId;

function renderModel() {
  return renderHook(() => {
    const model = useDataViewModel(STORAGE_KEY, [], undefined, undefined, {
      drafts: true,
      home: "all",
    });
    if (!model.ready) throw new Error("the fake core is always ready");
    return model;
  });
}

beforeEach(() => {
  toasts.length = 0;
  selected.length = 0;
  discard.mockClear();
  restore.mockClear();
  pendingCopy = COPY;
  activeId = "all";
});

describe("useDataViewModel — switching views under drafts", () => {
  it("discards the view being left and offers its edits back", () => {
    const { result } = renderModel();
    act(() => result.current.setActiveView("food"));

    expect(discard).toHaveBeenCalledWith("all");
    expect(selected).toEqual(["food"]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.description).toBe("All places reset to its saved filter");

    act(() => toasts[0]!.action!.onClick());
    expect(restore).toHaveBeenCalledWith("all", COPY);
    expect(selected).toEqual(["food", "all"]);
  });

  it("says nothing when the view had no edits", () => {
    pendingCopy = null;
    const { result } = renderModel();
    act(() => result.current.setActiveView("food"));
    expect(selected).toEqual(["food"]);
    expect(toasts).toHaveLength(0);
  });

  it("keeps the home view first and fixed", () => {
    const { result } = renderModel();
    expect(result.current.homeViewId).toBe("all");
    expect(() => result.current.actions.renameView("all", "x")).toThrow(/home/);
    expect(() => result.current.actions.deleteView("all")).toThrow(/home/);
  });
});
