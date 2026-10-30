import { describe, expect, test } from "bun:test";
import { deepOwnTarget } from "./portable-own-barrels";

const plugin = "plugins/infra/plugins/jobs";
const at = (rel: string) => `${plugin}/${rel}`;

describe("deepOwnTarget", () => {
  test("a deep import into the plugin's own core/ names its barrel spelling", () => {
    expect(
      deepOwnTarget(plugin, at("server/internal/a.ts"), "../../core/hold"),
    ).toEqual({
      folder: "core",
      barrel: "../../core",
    });
    expect(
      deepOwnTarget(
        plugin,
        at("server/index.ts"),
        "@plugins/infra/plugins/jobs/core/hold",
      ),
    ).toEqual({ folder: "core", barrel: "@plugins/infra/plugins/jobs/core" });
  });

  test("the barrel itself, server/ and shared/, and other plugins pass", () => {
    expect(deepOwnTarget(plugin, at("server/index.ts"), "../core")).toBeNull();
    expect(
      deepOwnTarget(plugin, at("server/index.ts"), "../core/index.ts"),
    ).toBeNull();
    expect(
      deepOwnTarget(plugin, at("server/index.ts"), "./internal/x"),
    ).toBeNull();
    expect(
      deepOwnTarget(plugin, at("server/index.ts"), "../shared/x"),
    ).toBeNull();
    expect(
      deepOwnTarget(plugin, at("server/index.ts"), "../plugins/child/core/x"),
    ).toBeNull();
    expect(
      deepOwnTarget(plugin, at("server/index.ts"), "@plugins/database/core"),
    ).toBeNull();
    expect(deepOwnTarget(plugin, at("server/index.ts"), "zod")).toBeNull();
  });
});
