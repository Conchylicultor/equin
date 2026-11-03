import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStructureTreeOnce } from "./structure-tree-once";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const dir = mkdtempSync(join(tmpdir(), "structure-tree-once-"));
const pluginsRoot = asAppPath(join(dir, "plugins"));
mkdirSync(join(pluginsRoot, "a", "plugins", "b"), { recursive: true });
writeFileSync(join(pluginsRoot, "a", "package.json"), "{}");
writeFileSync(join(pluginsRoot, "a", "plugins", "b", "package.json"), "{}");
// The tree reads the repo's file set from git.
Bun.spawnSync(["git", "init", "-q"], { cwd: dir });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildStructureTreeOnce", () => {
  test("every caller gets the same tree, built once per root", async () => {
    const [first, second] = await Promise.all([
      buildStructureTreeOnce(pluginsRoot),
      buildStructureTreeOnce(pluginsRoot),
    ]);
    expect(second).toBe(first);
    expect([...first.byPath.keys()].sort()).toEqual(["a", "a/plugins/b"]);
    expect(first.facets).toEqual([]);
  });

  test("the shared tree refuses mutation", async () => {
    const tree = await buildStructureTreeOnce(pluginsRoot);
    const a = tree.byPath.get("a")!;
    expect(() => {
      (a as { name: string }).name = "x";
    }).toThrow(TypeError);
    expect(() => a.children.push(a)).toThrow(TypeError);
    expect(() => tree.roots.push(a)).toThrow(TypeError);
    expect(() => {
      a.facets.x = 1;
    }).toThrow(TypeError);
    expect(() => tree.byDir.delete(a.dir)).toThrow(/read-only/);
    expect(() => tree.byPath.set("y", a)).toThrow(/read-only/);
    expect(() => tree.byPath.clear()).toThrow(/read-only/);
    // Reads still work.
    expect(tree.byPath.get("a/plugins/b")?.id as string).toBe("a.b");
  });
});
