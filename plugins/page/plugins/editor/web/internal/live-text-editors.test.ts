import { describe, expect, it } from "bun:test";
import { createLiveTextEditors, MAX_RECENT } from "./live-text-editors";

describe("live text editors", () => {
  it("is static until woken", () => {
    const live = createLiveTextEditors();
    expect(live.isLive("a")).toBe(false);
    live.wake("a");
    expect(live.isLive("a")).toBe(true);
  });

  it("keeps only the most recently woken past the cap, notifying the evicted", () => {
    const live = createLiveTextEditors();
    const notified: string[] = [];
    live.subscribe("b0", () => notified.push("b0"));
    for (let i = 0; i <= MAX_RECENT; i++) live.wake(`b${i}`);
    expect(live.isLive("b0")).toBe(false);
    expect(live.isLive(`b${MAX_RECENT}`)).toBe(true);
    expect(notified).toEqual(["b0", "b0"]);
  });

  it("re-waking moves a block to the recent end", () => {
    const live = createLiveTextEditors();
    for (let i = 0; i < MAX_RECENT; i++) live.wake(`b${i}`);
    live.wake("b0");
    live.wake("new");
    expect(live.isLive("b0")).toBe(true);
    expect(live.isLive("b1")).toBe(false);
  });

  it("never evicts a pinned block, and keeps it recent once unpinned", () => {
    const live = createLiveTextEditors();
    live.pin("focus", ["p"]);
    expect(live.isLive("p")).toBe(true);
    for (let i = 0; i < MAX_RECENT * 2; i++) live.wake(`b${i}`);
    expect(live.isLive("p")).toBe(true);
    live.pin("focus", []);
    expect(live.isLive("p")).toBe(true);
    live.wake("x");
    expect(live.isLive("p")).toBe(true);
  });
});
