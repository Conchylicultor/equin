import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readManifest } from "./read-manifest";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeManifest(root: string, rule: string): void {
  writeFileSync(
    join(root, "exempt", "index.ts"),
    `export default [{ rule: ${JSON.stringify(rule)}, paths: ["web/a.ts"], kind: "sanctioned", reason: "r" }];\n`,
  );
}

describe("readManifest", () => {
  test("re-reads an edited manifest instead of the cached module", () => {
    dir = mkdtempSync(join(tmpdir(), "exempt-manifest-"));
    mkdirSync(join(dir, "exempt"));
    writeManifest(dir, "first/rule");
    expect(readManifest(dir).map((e) => e.rule)).toEqual(["first/rule"]);

    writeManifest(dir, "second/rule");
    expect(readManifest(dir).map((e) => e.rule)).toEqual(["second/rule"]);
  });

  test("a plugin without a manifest declares nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "exempt-manifest-"));
    expect(readManifest(dir)).toEqual([]);
  });
});
