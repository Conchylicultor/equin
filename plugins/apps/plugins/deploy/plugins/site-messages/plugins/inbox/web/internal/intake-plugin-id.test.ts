import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { asFsPath } from "@plugins/framework/plugins/plugin-id/core";
import { INTAKE_PLUGIN_ID } from "./intake-plugin-id";

describe("INTAKE_PLUGIN_ID", () => {
  it("names the intake plugin's folder, which owns the host-only list endpoint", () => {
    const repoRoot = join(import.meta.dir, "../../../../../../../../../..");
    const dir = join(repoRoot, "plugins", asFsPath(INTAKE_PLUGIN_ID));
    expect(existsSync(join(dir, "core/internal/endpoints.ts"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });
});
