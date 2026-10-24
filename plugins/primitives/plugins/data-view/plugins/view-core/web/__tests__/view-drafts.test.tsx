import { symbol } from "@plugins/ui/plugins/icons/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { useViewModel } from "../internal/use-view-model";
import type { ViewConfigRow, ViewSourceEntry, ViewTypeMeta } from "../../core";

// Drafted views: every write to a view's `view` value lands in its working
// copy (sessionStorage, per tab) until saved, saved as new, or discarded. The
// config read/write is faked the way `use-views-config.test.tsx` fakes it.
const setConfigSpy = vi.fn();
let configDoc: { views: unknown[] } = { views: [] };
vi.mock("@plugins/config_v2/web", () => ({
  useConfigResult: () => ({
    status: "ready",
    data: configDoc,
    refetch: async () => {},
  }),
  useSetConfig: () => setConfigSpy,
}));

const viewIcon = symbol("view-list");
const contributions = [
  { type: "map", title: "Map", icon: viewIcon },
] as unknown as SealContributions<ViewTypeMeta>[];
const entries: ViewSourceEntry<ViewTypeMeta>[] = [{ contributions }];

// The drafts live in a tab-wide map keyed by surface, so each test drafts a
// surface of its own.
let keySeq = 0;
let storageKey = "";
const descriptorMap = {
  get: () => ({}) as ConfigDescriptor,
} as unknown as Map<string, ConfigDescriptor>;

const ALL = { type: "map" } as VariantValue;
const SAVED_B = { type: "map", filter: { tag: "b" } } as VariantValue;

beforeEach(() => {
  storageKey = `drafts-test-${++keySeq}`;
  setConfigSpy.mockClear();
  configDoc = {
    views: [
      { id: "all", name: "All", view: ALL },
      { id: "b", name: "B", view: SAVED_B },
    ],
  };
});

function renderDrafted(canonical?: (view: VariantValue) => unknown) {
  return renderHook(() =>
    useViewModel<ViewTypeMeta>(
      storageKey,
      descriptorMap,
      entries,
      undefined,
      undefined,
      {
        drafts: true,
        ...(canonical ? { canonical } : {}),
      },
    ),
  );
}

/** The last `views` rows written to the config (flushed on unmount). */
function flushed(unmount: () => void): ViewConfigRow[] {
  unmount();
  const last = setConfigSpy.mock.calls.at(-1);
  expect(last?.[0]).toBe("views");
  return last?.[1] as ViewConfigRow[];
}

describe("useViewModel — drafts", () => {
  it("is off by default: a write goes to the config", () => {
    const { result, unmount } = renderHook(() =>
      useViewModel<ViewTypeMeta>(storageKey, descriptorMap, entries, undefined),
    );
    expect(result.current.drafts).toBeNull();
    act(() =>
      result.current.updateView("b", { sort: [1] } as never, { merge: true }),
    );
    expect(result.current.dirtyFor("b")).toBe(false);
    expect(flushed(unmount).find((r) => r.id === "b")?.view).toEqual({
      ...SAVED_B,
      sort: [1],
    });
  });

  it("puts a write in the working copy and leaves the saved value alone", () => {
    const { result, unmount } = renderDrafted();
    act(() =>
      result.current.updateView("b", { sort: [1] } as never, { merge: true }),
    );
    expect(result.current.viewFor("b")).toEqual({ ...SAVED_B, sort: [1] });
    expect(result.current.savedViewFor("b")).toBe(SAVED_B);
    expect(result.current.dirtyFor("b")).toBe(true);
    expect(result.current.dirtyFor("all")).toBe(false);
    // The drafted instance renders its working copy.
    const b = result.current.instances.find((r) => r.instance.id === "b");
    expect(b?.instance.options).toMatchObject({ sort: [1] });
    unmount();
    expect(setConfigSpy).not.toHaveBeenCalled();
  });

  it("drops the copy when a write lands back on the saved value", () => {
    const { result } = renderDrafted();
    act(() =>
      result.current.updateView("b", { sort: [1] } as never, { merge: true }),
    );
    act(() =>
      result.current.updateView("b", { sort: undefined } as never, {
        merge: true,
      }),
    );
    expect(result.current.dirtyFor("b")).toBe(false);
    expect(result.current.viewFor("b")).toBe(SAVED_B);
  });

  it("compares under the consumer's projection", () => {
    const withoutFilter = (view: VariantValue) => ({
      ...view,
      filter: undefined,
    });
    const { result } = renderDrafted(withoutFilter);
    act(() =>
      result.current.updateView("b", { filter: { tag: "other" } } as never, {
        merge: true,
      }),
    );
    expect(result.current.dirtyFor("b")).toBe(false);
  });

  it("composes two writes in one tick", () => {
    const { result } = renderDrafted();
    act(() => {
      result.current.updateView("b", { sort: [1] } as never, { merge: true });
      result.current.updateView("b", { groupBy: "x" } as never, {
        merge: true,
      });
    });
    expect(result.current.viewFor("b")).toEqual({
      ...SAVED_B,
      sort: [1],
      groupBy: "x",
    });
  });

  it("save writes the copy to the config and drops it", () => {
    const { result, unmount } = renderDrafted();
    act(() =>
      result.current.updateView("b", { sort: [1] } as never, { merge: true }),
    );
    act(() => result.current.drafts!.save("b"));
    expect(result.current.dirtyFor("b")).toBe(false);
    expect(flushed(unmount).find((r) => r.id === "b")?.view).toEqual({
      ...SAVED_B,
      sort: [1],
    });
  });

  it("discard returns the copy, and restore puts it back", () => {
    const { result } = renderDrafted();
    act(() =>
      result.current.updateView("b", { sort: [1] } as never, { merge: true }),
    );
    let copy: VariantValue | null = null;
    act(() => {
      copy = result.current.drafts!.discard("b");
    });
    expect(copy).toEqual({ ...SAVED_B, sort: [1] });
    expect(result.current.dirtyFor("b")).toBe(false);
    expect(result.current.drafts!.discard("b")).toBeNull();
    act(() => result.current.drafts!.restore("b", copy!));
    expect(result.current.dirtyFor("b")).toBe(true);
    expect(result.current.viewFor("b")).toEqual({ ...SAVED_B, sort: [1] });
  });

  it("saveAsNew inserts the copy after its source, selects it and clears the source", () => {
    const { result, unmount } = renderDrafted();
    act(() =>
      result.current.updateView("all", { sort: [1] } as never, { merge: true }),
    );
    let id = "";
    act(() => {
      id = result.current.drafts!.saveAsNew("all", { name: "Sorted" });
    });
    expect(result.current.instances.map((r) => r.instance.id)).toEqual([
      "all",
      id,
      "b",
    ]);
    expect(result.current.activeId).toBe(id);
    expect(result.current.dirtyFor("all")).toBe(false);
    const rows = flushed(unmount);
    expect(rows[0]!.view).toEqual(ALL);
    expect(rows[1]).toMatchObject({
      id,
      name: "Sorted",
      view: { type: "map", sort: [1] },
    });
  });

  it("keeps the working copy for this tab across a remount", () => {
    const first = renderDrafted();
    act(() =>
      first.result.current.updateView("b", { sort: [1] } as never, {
        merge: true,
      }),
    );
    first.unmount();
    const second = renderDrafted();
    expect(second.result.current.dirtyFor("b")).toBe(true);
  });

  it("deleting a view drops its copy", () => {
    const { result } = renderDrafted();
    act(() =>
      result.current.updateView("b", { sort: [1] } as never, { merge: true }),
    );
    act(() => result.current.actions.deleteView("b"));
    expect(result.current.drafts!.discard("b")).toBeNull();
  });
});
