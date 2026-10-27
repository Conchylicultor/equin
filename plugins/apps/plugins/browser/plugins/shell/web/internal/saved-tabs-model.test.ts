import { describe, expect, test } from "bun:test";
import type { BrowserTab, BrowserTabsState } from "../nav-store";
import {
  mergeSaved,
  restoreState,
  toSaved,
  type SavedTab,
} from "./saved-tabs-model";

function saved(key: string, over: Partial<SavedTab> = {}): SavedTab {
  return {
    key,
    url: `https://${key}.test/`,
    pageUrl: `https://${key}.test/`,
    title: key,
    faviconUrl: null,
    ...over,
  };
}

function tab(key: string, over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: key,
    key,
    url: `https://${key}.test/`,
    pageUrl: `https://${key}.test/`,
    remote: true,
    title: key,
    faviconUrl: null,
    loading: false,
    canGoBack: true,
    canGoForward: false,
    request: null,
    sentSeq: 3,
    ...over,
  };
}

function state(tabs: BrowserTab[], activeId: string): BrowserTabsState {
  return { tabs, activeId, seq: 7, pendingCloses: [] };
}

describe("restoreState", () => {
  test("restores every tab by key, selecting the saved active one", () => {
    const s = restoreState({
      tabs: [saved("a"), saved("b"), saved("c", { url: "", pageUrl: "" })],
      activeKey: "b",
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(s.activeId).toBe("b");
    expect(s.tabs[0]?.remote).toBe(true);
    // A start-page tab that never had a page has no remote page to reattach.
    expect(s.tabs[2]?.remote).toBe(false);
    expect(s.tabs[0]?.request).toBeNull();
  });

  test("falls back to the first tab when the active one is unknown", () => {
    expect(restoreState({ tabs: [saved("a")], activeKey: "x" }).activeId).toBe(
      "a",
    );
  });
});

describe("toSaved", () => {
  test("drops data: favicons and names the active tab by key", () => {
    const out = toSaved(
      state(
        [
          tab("a", { faviconUrl: "data:image/png;base64,AAAA" }),
          tab("b", { faviconUrl: "https://b.test/favicon.ico" }),
        ],
        "b",
      ),
    );
    expect(out.activeKey).toBe("b");
    expect(out.tabs.map((t) => t.faviconUrl)).toEqual([
      null,
      "https://b.test/favicon.ico",
    ]);
  });

  test("round-trips through restoreState", () => {
    const s = state([tab("a"), tab("b")], "a");
    expect(toSaved(restoreState(toSaved(s)))).toEqual(toSaved(s));
  });
});

describe("mergeSaved", () => {
  test("keeps delivery state of shared tabs and takes the saved fields", () => {
    const merged = mergeSaved(state([tab("a"), tab("b")], "a"), {
      tabs: [saved("a", { title: "A2" }), saved("b")],
      activeKey: "b",
    });
    expect(merged.tabs[0]?.title).toBe("A2");
    expect(merged.tabs[0]?.sentSeq).toBe(3);
    expect(merged.tabs[0]?.canGoBack).toBe(true);
    // Each surface keeps its own selection.
    expect(merged.activeId).toBe("a");
    expect(merged.seq).toBe(7);
  });

  test("adds tabs opened elsewhere and drops tabs closed elsewhere", () => {
    const merged = mergeSaved(state([tab("a"), tab("b"), tab("c")], "b"), {
      tabs: [saved("a"), saved("c"), saved("d")],
      activeKey: "a",
    });
    expect(merged.tabs.map((t) => t.key)).toEqual(["a", "c", "d"]);
    // The closed active tab gives way to the one that took its place.
    expect(merged.activeId).toBe("c");
    expect(merged.pendingCloses).toEqual([]);
  });

  test("keeps a data: favicon this surface knows when the saved one is null", () => {
    const icon = "data:image/png;base64,AAAA";
    const merged = mergeSaved(state([tab("a", { faviconUrl: icon })], "a"), {
      tabs: [saved("a")],
      activeKey: "a",
    });
    expect(merged.tabs[0]?.faviconUrl).toBe(icon);
  });
});
