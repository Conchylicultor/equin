import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";
import { CENTRAL_ENTRY } from "../../core";
import { centralCodeSet } from "../../shared/central-code-set";
import { centralBuildOf } from "./central-build";

// This checkout's root: cli/internal → the plugin → build → plugins → root.
const ROOT = resolve(import.meta.dir, "../../../../../..");

describe("central's code build", () => {
  test("CENTRAL_ENTRY is central's bin in this checkout", () => {
    expect(existsSync(join(ROOT, CENTRAL_ENTRY))).toBe(true);
  });

  test("the build's digest is the one central computes over the same entry", async () => {
    // Central's half: the entry it runs (realpath'd), digested through the
    // same walk (source-digest's central barrel re-exports the server's) —
    // the two sides must name one build for one code.
    const entry = realpathSync(join(ROOT, CENTRAL_ENTRY));
    const central = await sourceDigest([
      centralCodeSet(pathToFileURL(entry).href),
    ]);
    const build = await centralBuildOf(ROOT);
    expect(build).toMatch(/^[0-9a-f]{64}$/);
    expect(build).toBe(central);
  });
});
