import { describe, expect, test } from "bun:test";
import { ASSET_PATH, assetBase } from "./asset-path";
import { blob } from "./codec";
import { defineEndpoint } from "./define-endpoint";

const mirrored = defineEndpoint({
  route: "GET /api/mirror/:id/:dir/:file",
  response: blob(),
  needsMachine: { feature: "The mirror" },
});

describe("assetBase", () => {
  test("is the route's path cut before its first param left open", () => {
    const base = assetBase(mirrored, { id: "a b" });
    expect(base[ASSET_PATH]).toBe("/api/mirror/a%20b");
    expect(base.needsMachine).toEqual({ feature: "The mirror" });
    expect(assetBase(mirrored, { id: "x", dir: "en" })[ASSET_PATH]).toBe(
      "/api/mirror/x/en",
    );
  });

  test("throws for a param given after one left open, or none left open", () => {
    expect(() => assetBase(mirrored, { dir: "en" })).toThrow(
      'param "dir" comes after a param left open',
    );
    expect(() =>
      assetBase(mirrored, { id: "x", dir: "en", file: "f.json" }),
    ).toThrow("every param is given");
  });
});
