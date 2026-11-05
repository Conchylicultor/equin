import { describe, expect, test } from "bun:test";
import { isStaleOrigin } from "./sources";

describe("isStaleOrigin", () => {
  test("an outdated bundle's report about its own code is stale", () => {
    expect(
      isStaleOrigin({
        source: "browser-error",
        buildId: "old",
        serverGraph: "new",
      }),
    ).toBe(true);
  });

  test("an outdated bundle's report about the server is not: the bundle's age explains no unanswered sub", () => {
    expect(
      isStaleOrigin({
        source: "live-state-wedge",
        buildId: "old",
        serverGraph: "new",
      }),
    ).toBe(false);
  });

  test("the current bundle, or an unknown one on either side, is never stale", () => {
    for (const [buildId, serverGraph] of [
      ["same", "same"],
      [null, "new"],
      [undefined, "new"],
      ["old", null],
    ] as const) {
      expect(
        isStaleOrigin({ source: "browser-error", buildId, serverGraph }),
      ).toBe(false);
    }
  });
});
