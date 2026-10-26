import { symbol } from "@plugins/ui/plugins/icons/core";
import { act, renderHook } from "@testing-library/react";
import { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useViewModel } from "../internal/use-view-model";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";

// THE URL IS DERIVED FROM THE ACTIVE VIEW. While the surface is bound to an
// address key, whatever is on screen is what the address says — nothing on the
// static default (`defaultView`, else the first view), the active id otherwise.
// A switch writes it, a switch back removes it, a view restored from this
// device is stamped in, a URL-named view is adopted locally, and a stale id is
// rewritten to the view actually shown. Every write replaces (the binding's
// own concern); here the binding is a plain state cell that records writes.
vi.mock("@plugins/config_v2/web", () => ({
  useConfigResult: () => ({
    status: "ready",
    data: {
      views: [
        { id: "recent", name: "Recent", view: { type: "list" } },
        { id: "failures", name: "Failures", view: { type: "list" } },
        { id: "all", name: "All", view: { type: "list" } },
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

// The device-local selection persists per surface, so each test gets its own.
let keySeq = 0;
let storageKey = "";
beforeEach(() => {
  storageKey = `view-url-test-${++keySeq}`;
});

function renderBound(initialUrl: string | undefined, defaultView?: string) {
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
      defaultView,
      undefined,
      { activeViewUrl: url },
    );
    return { model, url: value };
  });
  return { ...hook, writes };
}

/** Pick `id` on this device with no URL bound, as a previous visit would. */
function persist(id: string) {
  const { result, unmount } = renderHook(() =>
    useViewModel<ViewTypeMeta>(storageKey, descriptorMap, entries, undefined),
  );
  act(() => result.current.setActiveView(id));
  unmount();
}

describe("useViewModel — the URL derived from the active view", () => {
  it("adds nothing on the default view", () => {
    const { result, writes } = renderBound(undefined);
    expect(result.current.model.activeId).toBe("recent");
    expect(result.current.url).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("takes an authored defaultView as the static default", () => {
    const { result, writes } = renderBound(undefined, "all");
    expect(result.current.model.activeId).toBe("all");
    expect(writes).toEqual([]);
  });

  it("writes the key on a switch and removes it on the way back", () => {
    const { result } = renderBound(undefined);
    act(() => result.current.model.setActiveView("failures"));
    expect(result.current.model.activeId).toBe("failures");
    expect(result.current.url).toBe("failures");

    act(() => result.current.model.setActiveView("recent"));
    expect(result.current.model.activeId).toBe("recent");
    expect(result.current.url).toBeUndefined();
  });

  it("switches away from a view the URL named", () => {
    const { result } = renderBound("failures");
    act(() => result.current.model.setActiveView("all"));
    expect(result.current.model.activeId).toBe("all");
    expect(result.current.url).toBe("all");
  });

  it("stamps a view restored from this device into the URL", () => {
    persist("all");
    const { result, writes } = renderBound(undefined);
    expect(result.current.model.activeId).toBe("all");
    expect(result.current.url).toBe("all");
    expect(writes).toEqual(["all"]);
  });

  it("adopts a URL-named view locally", () => {
    persist("all");
    const first = renderBound("failures");
    expect(first.result.current.model.activeId).toBe("failures");
    expect(first.writes).toEqual([]);
    first.unmount();

    // A bare address now opens the view the URL showed last.
    const second = renderBound(undefined);
    expect(second.result.current.model.activeId).toBe("failures");
  });

  it("rewrites an unknown URL id to the view actually shown", () => {
    const { result, writes } = renderBound("gone");
    expect(result.current.model.activeId).toBe("recent");
    expect(result.current.url).toBeUndefined();
    expect(writes).toEqual([undefined]);

    persist("all");
    const restored = renderBound("gone");
    expect(restored.result.current.model.activeId).toBe("all");
    expect(restored.result.current.url).toBe("all");
  });
});
