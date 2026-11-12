import { symbol } from "@plugins/ui/plugins/icons/core";
import { act, renderHook } from "@testing-library/react";
import { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { useViewModel } from "../internal/use-view-model";
import { encodeViewAddress } from "../internal/view-address";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";

// A DRAFTED VIEW IS ADDRESSABLE. Under drafts the URL value carries the active
// view's working copy (`<id>~<draft>`), so the address reproduces the screen;
// a value arriving from outside seeds the copy. Without drafts the URL holds
// the id alone (`view-url.test.tsx`).
vi.mock("@plugins/config_v2/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConfigResult: () => ({
    status: "ready",
    data: {
      views: [
        { id: "recent", name: "Recent", view: { type: "list" } },
        { id: "failures", name: "Failures", view: { type: "list" } },
      ],
    },
    refetch: async () => {},
  }),
  useSetConfig: () => () => {},
}));

const contributions = [
  { type: "list", title: "List", icon: symbol("view-list") },
] as unknown as SealContributions<ViewTypeMeta>[];
const entries: ViewSourceEntry<ViewTypeMeta>[] = [{ contributions }];
const descriptorMap = {
  get: () => ({}) as ConfigDescriptor,
} as unknown as Map<string, ConfigDescriptor>;

const SORTED = { type: "list", sort: [1] } as VariantValue;

let keySeq = 0;
let storageKey = "";
beforeEach(() => {
  storageKey = `view-url-drafts-test-${++keySeq}`;
});

function renderBound(initialUrl: string | undefined, drafts = true) {
  const writes: Array<string | undefined> = [];
  const hook = renderHook(() => {
    const [value, setValue] = useState(initialUrl);
    const url = useMemo(
      () => ({
        value,
        set: (v: string | undefined) => {
          writes.push(v);
          setValue(v);
        },
      }),
      [value],
    );
    const model = useViewModel<ViewTypeMeta>(
      storageKey,
      descriptorMap,
      entries,
      undefined,
      undefined,
      { drafts, activeViewUrl: url },
    );
    // Stands for the address changing from outside (a link, back/forward).
    return { model, url: value, navigate: setValue };
  });
  return { ...hook, writes };
}

describe("useViewModel — a drafted view in the URL", () => {
  it("puts a draft in the URL, and takes it out on discard", () => {
    const { result } = renderBound(undefined);
    act(() =>
      result.current.model.updateView("recent", { sort: [1] } as never, {
        merge: true,
      }),
    );
    // The static default is named while it carries a copy.
    expect(result.current.url).toBe(encodeViewAddress("recent", SORTED));
    expect(result.current.url).toMatch(/^recent~[A-Za-z0-9_-]+$/);

    act(() => {
      result.current.model.drafts!.discard("recent");
    });
    expect(result.current.url).toBeUndefined();
  });

  it("names a non-default view with its draft, and without it once dropped", () => {
    const { result } = renderBound("failures");
    act(() =>
      result.current.model.updateView("failures", { sort: [1] } as never, {
        merge: true,
      }),
    );
    expect(result.current.url).toBe(encodeViewAddress("failures", SORTED));
    act(() => {
      result.current.model.drafts!.discard("failures");
    });
    expect(result.current.url).toBe("failures");
  });

  it("seeds the copy from a URL opened with a draft", () => {
    const address = encodeViewAddress("failures", SORTED);
    const { result, writes } = renderBound(address);
    expect(result.current.model.activeId).toBe("failures");
    expect(result.current.model.viewFor("failures")).toEqual(SORTED);
    expect(result.current.model.dirtyFor("failures")).toBe(true);
    expect(writes).toEqual([]);
  });

  it("follows the URL when it changes from outside", () => {
    const { result } = renderBound("failures");
    act(() => result.current.navigate(encodeViewAddress("failures", SORTED)));
    expect(result.current.model.viewFor("failures")).toEqual(SORTED);

    // The view named with no draft part drops its copy.
    act(() => result.current.navigate("failures"));
    expect(result.current.model.dirtyFor("failures")).toBe(false);
    expect(result.current.url).toBe("failures");
  });

  it("ignores a malformed draft part and rewrites the URL", () => {
    const { result } = renderBound("failures~***");
    expect(result.current.model.activeId).toBe("failures");
    expect(result.current.model.dirtyFor("failures")).toBe(false);
    expect(result.current.url).toBe("failures");
  });

  it("writes the new view's own copy on a switch", () => {
    const { result } = renderBound(undefined);
    act(() =>
      result.current.model.updateView("failures", { sort: [1] } as never, {
        merge: true,
      }),
    );
    // Editing a view that is not on screen leaves the address alone.
    expect(result.current.url).toBeUndefined();
    act(() => result.current.model.setActiveView("failures"));
    expect(result.current.url).toBe(encodeViewAddress("failures", SORTED));
    act(() => result.current.model.setActiveView("recent"));
    expect(result.current.url).toBeUndefined();
  });

  it("keeps the bare id without drafts", () => {
    const { result, writes } = renderBound("failures", false);
    act(() =>
      result.current.model.updateView("failures", { sort: [1] } as never, {
        merge: true,
      }),
    );
    expect(result.current.url).toBe("failures");
    expect(writes).toEqual([]);
  });
});
