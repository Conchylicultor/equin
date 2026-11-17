import { describe, expect, it } from "bun:test";
import { trailChange } from "./trail-motion";

const seg = (...keys: string[]) => keys.map((key) => ({ key }));

describe("trailChange", () => {
  it("going deeper wipes the new crumbs in and dims the old current one", () => {
    const c = trailChange(seg("a", "b"), seg("a", "b", "c"));
    expect([...c.entering]).toEqual(["c"]);
    expect(c.leaving).toEqual([]);
    expect(c.demoted).toBe("b");
    expect(c.promoted).toBeNull();
  });

  it("going back up keeps the dropped crumbs to wipe out and brightens the new current one", () => {
    const c = trailChange(seg("a", "b", "c", "d"), seg("a", "b"));
    expect([...c.entering]).toEqual([]);
    expect(c.leaving.map((s) => s.key)).toEqual(["c", "d"]);
    expect(c.promoted).toBe("b");
    expect(c.demoted).toBeNull();
  });

  it("another place altogether animates nothing", () => {
    const c = trailChange(seg("a", "b"), seg("a", "x"));
    expect(c.entering.size).toBe(0);
    expect(c.leaving).toEqual([]);
    expect(c.demoted).toBeNull();
    expect(c.promoted).toBeNull();
  });
});
