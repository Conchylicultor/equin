import { describe, expect, test } from "bun:test";
import { createHandOver } from "./hand-over";

describe("createHandOver", () => {
  test("a step after the handover waits for the downgrade, then runs once", async () => {
    const log: string[] = [];
    const h = createHandOver(async () => {
      log.push("downgrade");
    });
    await h.afterHandOver(async () => {
      log.push("central spec");
    });
    expect(log).toEqual([]);
    await h.handOver();
    expect(log).toEqual(["downgrade", "central spec"]);
    await h.handOver();
    expect(log).toEqual(["downgrade", "central spec"]);
    // Past the handover, a step runs at once.
    await h.afterHandOver(async () => {
      log.push("later");
    });
    expect(log).toEqual(["downgrade", "central spec", "later"]);
  });

  test("with no slot lease, a step runs at once", async () => {
    const log: string[] = [];
    const h = createHandOver(null);
    await h.afterHandOver(async () => {
      log.push("central spec");
    });
    expect(log).toEqual(["central spec"]);
    await h.handOver();
    expect(log).toEqual(["central spec"]);
  });
});
