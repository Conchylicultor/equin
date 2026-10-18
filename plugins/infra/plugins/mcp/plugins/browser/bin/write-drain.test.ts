import { describe, expect, test } from "bun:test";
import { createInFlight } from "./write-drain";

describe("createInFlight", () => {
  test("nothing outstanding: empty at once", async () => {
    expect(await createInFlight<string>().whenEmpty(10)).toBe(true);
  });

  test("resolves only when the LAST outstanding request is answered", async () => {
    const f = createInFlight<string>();
    f.add("a");
    f.add("b");
    let settled = false;
    const empty = f.whenEmpty(1_000).then((v) => {
      settled = true;
      return v;
    });
    f.remove("a");
    await Promise.resolve();
    expect(settled).toBe(false);
    f.remove("b");
    expect(await empty).toBe(true);
  });

  test("a request still open at the deadline is a timeout, and named", async () => {
    const f = createInFlight<string>();
    f.add("POST /api/config");
    expect(await f.whenEmpty(20)).toBe(false);
    expect(f.pending()).toEqual(["POST /api/config"]);
  });

  test("removing an unknown key wakes nobody", async () => {
    const f = createInFlight<string>();
    f.add("a");
    const empty = f.whenEmpty(30);
    f.remove("x");
    expect(await empty).toBe(false);
  });
});
