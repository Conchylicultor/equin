import { beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal in-memory Storage - jsdom's sessionStorage under vitest is inert. */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  key(i: number) {
    return [...this.store.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
}

const PAYLOAD = {
  tabs: [{ tabId: "t-pages", appId: "pages", route: [], rawPath: "" }],
  focusedTabId: "t-pages",
  mode: "floating",
};

// The store scans its area once per module instance, so each test loads fresh
// modules over a fresh storage seeded with the pre-primitive keys.
beforeEach(() => {
  const mem = new MemoryStorage();
  Object.defineProperty(window, "sessionStorage", {
    value: mem,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: mem,
    configurable: true,
  });
  vi.resetModules();
});

describe("tabs-store legacy keys", () => {
  it("adopts app-tabs:<tabId>:<generation> as an entry of the store, drops the older 2-segment key", async () => {
    sessionStorage.setItem("app-tabs:tab-1:gen-1", JSON.stringify(PAYLOAD));
    sessionStorage.setItem("app-tabs:tab-1", JSON.stringify(PAYLOAD));
    const { loadPersistedTabs } = await import("../internal/tabs-store");
    // Touching the store runs its one legacy scan.
    loadPersistedTabs();
    expect(sessionStorage.getItem("app-tabs:tab-1:gen-1")).toBeNull();
    expect(sessionStorage.getItem("app-tabs:tab-1")).toBeNull();
    const adopted = sessionStorage.getItem("s:apps-core.tabs:tab-1:gen-1");
    expect(adopted).not.toBeNull();
    expect((JSON.parse(adopted!) as { v: unknown }).v).toEqual(PAYLOAD);
  });
});
