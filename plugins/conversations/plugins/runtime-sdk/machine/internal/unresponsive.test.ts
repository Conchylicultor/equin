import { describe, expect, test } from "bun:test";
import { createUnresponsiveTracker } from "./unresponsive";

describe("createUnresponsiveTracker", () => {
  test("a stretch shorter than the bound is not reported", () => {
    const t = createUnresponsiveTracker(300);
    expect(t.observe("a", 0, "no reply")).toBeNull();
    expect(t.observe("a", 299, "no reply")).toBeNull();
  });

  test("a stretch reaching the bound is reported once, from its first miss", () => {
    const t = createUnresponsiveTracker(300);
    t.observe("a", 100, "first");
    expect(t.observe("a", 400, "latest")).toEqual({
      since: 100,
      detail: "latest",
    });
    expect(t.observe("a", 900, "latest")).toBeNull();
  });

  test("an answer ends the stretch; the next one starts over", () => {
    const t = createUnresponsiveTracker(300);
    t.observe("a", 0, "miss");
    t.observe("a", 200, null);
    expect(t.observe("a", 350, "miss")).toBeNull();
    expect(t.observe("a", 650, "miss")).toEqual({ since: 350, detail: "miss" });
  });

  test("agents are tracked apart", () => {
    const t = createUnresponsiveTracker(300);
    t.observe("a", 0, "miss");
    expect(t.observe("b", 300, "miss")).toBeNull();
    expect(t.observe("a", 300, "miss")).not.toBeNull();
  });

  test("retain forgets agents no longer running", () => {
    const t = createUnresponsiveTracker(300);
    t.observe("a", 0, "miss");
    t.retain(["b"]);
    expect(t.observe("a", 300, "miss")).toBeNull();
  });
});
