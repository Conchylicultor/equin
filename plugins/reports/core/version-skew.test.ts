import { describe, expect, test } from "bun:test";
import { fromOutdatedBundle, versionSkewMayExplain } from "./version-skew";

describe("fromOutdatedBundle", () => {
  test("a bundle whose graph is not the served one is outdated", () => {
    expect(fromOutdatedBundle({ buildId: "old", serverGraph: "new" })).toBe(
      true,
    );
  });

  test("the current bundle, or an unknown one on either side, is not", () => {
    for (const [buildId, serverGraph] of [
      ["same", "same"],
      [null, "new"],
      [undefined, "new"],
      ["old", null],
    ] as const) {
      expect(fromOutdatedBundle({ buildId, serverGraph })).toBe(false);
    }
  });
});

describe("versionSkewMayExplain", () => {
  test("an outdated tab failing to load what the server serves now: skew may explain it", () => {
    for (const source of ["plugin-load", "boot-snapshot"]) {
      expect(versionSkewMayExplain({ source, staleOrigin: true })).toBe(true);
    }
  });

  test("an outdated tab dropping a stored entry it cannot read is its own code destroying data, not skew (2026-11-12: demo-scope.host-generation dropped by a stale tab)", () => {
    expect(
      versionSkewMayExplain({ source: "client-storage", staleOrigin: true }),
    ).toBe(false);
  });

  test("an outdated tab's own code misbehaving is a bug in that code, not skew (2026-11-11: a render loop on 10 builds, prototype render loops at 603/s)", () => {
    for (const source of [
      "browser-error",
      "browser-rejection",
      "react-boundary",
      "client-render-loop",
      "client-main-thread-stall",
      "client-slow-interaction",
      // web-storage never reports another build's entry (2026-11-11: a stale
      // tab dropped demo-scope.host-generation, muted as skew).
      "client-storage",
    ]) {
      expect(versionSkewMayExplain({ source, staleOrigin: true })).toBe(false);
    }
  });

  test("what an outdated tab saw the server do is the server's (a loader that failed, a 5xx, an unanswered sub)", () => {
    for (const source of [
      "client-resource-error",
      "client-endpoint",
      "live-state-wedge",
      "client-live-state-stale-drop",
      "server-uncaught",
      "cli",
    ]) {
      expect(versionSkewMayExplain({ source, staleOrigin: true })).toBe(false);
    }
  });

  test("a report seen from a tab on the served graph is never skew", () => {
    expect(
      versionSkewMayExplain({ source: "plugin-load", staleOrigin: false }),
    ).toBe(false);
  });
});
