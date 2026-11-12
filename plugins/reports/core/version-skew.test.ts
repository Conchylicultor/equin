import { describe, expect, test } from "bun:test";
import {
  fromOutdatedBundle,
  skewProofOf,
  versionSkewExplains,
} from "./version-skew";

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

describe("versionSkewExplains", () => {
  test("only a row whose every occurrence proved skew", () => {
    expect(versionSkewExplains({ skewProven: true })).toBe(true);
    expect(versionSkewExplains({ skewProven: false })).toBe(false);
  });
});

describe("skewProofOf", () => {
  test("a module load is proven by a retired file, another schema's entry by the outdated tab", () => {
    expect(skewProofOf("plugin-load")).toBe("retired-file");
    expect(skewProofOf("client-storage-other-schema")).toBe("outdated-tab");
  });

  test("everything else — the boot snapshot and server sources included — proves nothing", () => {
    for (const source of [
      "boot-snapshot",
      "browser-error",
      "client-storage",
      "client-resource-error",
      "server-crash",
    ]) {
      expect(skewProofOf(source)).toBe("none");
    }
  });
});
