import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { asFsPath } from "@plugins/framework/plugins/plugin-id/core";
import { COLLECT_PLUGIN_ID } from "./plugin-id";

describe("COLLECT_PLUGIN_ID", () => {
  it("names this plugin's folder, which owns the analytics query endpoint", () => {
    const dir = join(REPO_ROOT, "plugins", asFsPath(COLLECT_PLUGIN_ID));
    expect(existsSync(join(dir, "core/internal/endpoints.ts"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });
});
