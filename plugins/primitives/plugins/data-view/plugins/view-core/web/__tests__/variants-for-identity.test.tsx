import { symbol } from "@plugins/ui/plugins/icons/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useViewModel } from "../internal/use-view-model";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";

// `actions.variantsFor(id)` must hand back the SAME Map for a view until that
// view's own source entry or type changes — the settings popover keys its field
// def on it, so a fresh Map would rebuild the whole sub-form on every keystroke.
// Config is mocked as in `use-views-config.test.tsx`: a fixed settled read, so
// the optimistic mirror is what each write lands in.
let configDoc: { views: unknown[] } = { views: [] };
vi.mock("@plugins/config_v2/web", () => ({
  useConfigResult: () => ({
    status: "ready",
    data: configDoc,
    refetch: async () => {},
  }),
  useSetConfig: () => () => {},
}));

const viewIcon = symbol("view-list");

const contributions = [
  { type: "table", title: "Table", icon: viewIcon },
  { type: "gallery", title: "Gallery", icon: viewIcon },
] as unknown as SealContributions<ViewTypeMeta>[];

const entries: ViewSourceEntry<ViewTypeMeta>[] = [{ contributions }];

const descriptorMap = new Map<string, ConfigDescriptor>([
  ["k", {} as ConfigDescriptor],
]);

function renderModel() {
  return renderHook(() =>
    useViewModel<ViewTypeMeta>("k", descriptorMap, entries, undefined),
  );
}

beforeEach(() => {
  localStorage.clear();
  configDoc = {
    views: [
      { id: "a", name: "A", view: { type: "table" } },
      { id: "b", name: "B", view: { type: "table" } },
    ],
  };
});

describe("useViewModel — variantsFor identity", () => {
  it("keeps a view's Map across a rerender", () => {
    const { result, rerender } = renderModel();
    const variants = result.current.actions.variantsFor("a");
    expect([...variants.keys()].sort()).toEqual(["gallery", "table"]);
    rerender();
    expect(result.current.actions.variantsFor("a")).toBe(variants);
  });

  it("is untouched by edits to another view", () => {
    const { result } = renderModel();
    const variants = result.current.actions.variantsFor("a");
    act(() => result.current.actions.renameView("b", "B2"));
    act(() =>
      result.current.actions.updateView(
        "b",
        { type: "gallery" },
        {
          merge: true,
        },
      ),
    );
    expect(result.current.actions.variantsFor("a")).toBe(variants);
  });

  it("is untouched by renaming the view or editing its options", () => {
    const { result } = renderModel();
    const variants = result.current.actions.variantsFor("a");
    act(() => result.current.actions.renameView("a", "A2"));
    expect(result.current.actions.variantsFor("a")).toBe(variants);
    act(() =>
      result.current.actions.updateView(
        "a",
        { type: "table", dense: true },
        {
          merge: true,
        },
      ),
    );
    expect(result.current.actions.variantsFor("a")).toBe(variants);
  });

  it("re-derives when the view's type changes", () => {
    const { result } = renderModel();
    const variants = result.current.actions.variantsFor("a");
    act(() =>
      result.current.actions.updateView(
        "a",
        { type: "gallery" },
        {
          merge: true,
        },
      ),
    );
    const after = result.current.actions.variantsFor("a");
    expect(after).not.toBe(variants);
    expect([...after.keys()].sort()).toEqual(["gallery", "table"]);
  });

  it("hands back one stable empty Map for an unknown id", () => {
    const { result, rerender } = renderModel();
    const unknown = result.current.actions.variantsFor("nope");
    expect(unknown.size).toBe(0);
    rerender();
    expect(result.current.actions.variantsFor("nope")).toBe(unknown);
  });
});
