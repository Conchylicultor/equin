// The fixture repo keeps its plugins under `pkgs/`, not `plugins/`: a literal
// spelled `plugins/…` is a reference to a real plugin (plugin-refs).
import { describe, expect, test } from "bun:test";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { repoFilesOver } from "@plugins/framework/plugins/tooling/core";
import { buildPluginTree, type PluginTreeData } from "./plugin-tree";
import { createStructureIndex, type StructureIndexIo } from "./structure-index";

const ROOT = asAppPath("/repo");

const barrel = (description: string, extra = "") =>
  `export default {\n  description: ${JSON.stringify(description)},${extra}\n};\n`;

/** An in-memory repo: path → text. Counts what the index asks of it. */
function fakeRepo(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const asked: string[][] = [];
  const reads: string[] = [];
  const io: StructureIndexIo = {
    allMembers: async () => [...disk.keys()],
    membersIn: async (paths) => {
      asked.push([...paths]);
      return [...disk.keys()].filter((f) =>
        paths.some((p) => f === p || f.startsWith(`${p}/`)),
      );
    },
    read: async (path) => {
      reads.push(path);
      return disk.get(path) ?? null;
    },
  };
  return { disk, io, asked, reads };
}

/** The tree as plain data, for comparison with a cold build. */
function shape(tree: PluginTreeData): unknown {
  return [...tree.byPath.values()].map((n) => ({
    path: n.path,
    id: n.id,
    description: n.description,
    descriptions: n.descriptions,
    loadBearing: n.loadBearing,
    collapsed: n.collapsed,
    compositionRoot: n.compositionRoot,
    runtimes: n.runtimes,
    children: n.children.map((c) => c.path),
  }));
}

async function coldShape(disk: Map<string, string>): Promise<unknown> {
  const repo = repoFilesOver(ROOT, [...disk.keys()].sort());
  const real = {
    ...repo,
    read: async (p: string) => disk.get(p) ?? null,
  };
  return shape(await buildPluginTree(asAppPath("/repo/pkgs"), { repo: real }));
}

const BASE = {
  "pkgs/a/web/index.ts": barrel("A web"),
  "pkgs/a/package.json": "{}",
  "pkgs/a/web/components/x.tsx": "x",
  "pkgs/a/plugins/b/server/index.ts": barrel("B", " loadBearing: true,"),
  "pkgs/a/plugins/b/server/internal/y.ts": "y",
  "pkgs/c/core/index.ts": "export {};",
  "pkgs/c/node_modules/z/index.js": "z",
  "README.md": "not a plugin",
};

describe("createStructureIndex", () => {
  test("cold build equals buildPluginTree", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
    expect(index.tree().byPath.has("c")).toBe(true);
  });

  test("an ordinary source edit changes nothing and reads no key file", async () => {
    const { disk, io, reads } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    const before = index.tree();
    reads.length = 0;
    disk.set("pkgs/a/web/components/x.tsx", "x2");
    expect(await index.refresh(["pkgs/a/web/components/x.tsx"])).toBe(false);
    expect(reads).toEqual([]);
    expect(index.tree()).toBe(before);
  });

  test("a barrel edit re-reads that plugin only", async () => {
    const { disk, io, reads } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    reads.length = 0;
    disk.set("pkgs/a/plugins/b/server/index.ts", barrel("B2"));
    expect(await index.refresh(["pkgs/a/plugins/b/server/index.ts"])).toBe(
      true,
    );
    expect(reads.every((r) => r.startsWith("pkgs/a/plugins/b/"))).toBe(true);
    expect(index.tree().byPath.get("a/plugins/b")?.description).toBe("B2");
    expect(index.tree().byPath.get("a/plugins/b")?.loadBearing).toBe(false);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
  });

  test("a barrel saved unchanged is not a change", async () => {
    const { io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    expect(await index.refresh(["pkgs/a/web/index.ts"])).toBe(false);
  });

  test("a plugin added as a folder, then removed as a folder", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    disk.set("pkgs/a/plugins/new/web/index.ts", barrel("New"));
    disk.set("pkgs/a/plugins/new/web/thing.ts", "t");
    expect(await index.refresh(["pkgs/a/plugins/new"])).toBe(true);
    expect(
      index
        .tree()
        .byPath.get("a")
        ?.children.map((c) => c.path),
    ).toEqual(["a/plugins/b", "a/plugins/new"]);
    expect(index.tree().byPath.get("a/plugins/new")?.id as string).toBe(
      "a.new",
    );
    expect(shape(index.tree())).toEqual(await coldShape(disk));

    disk.delete("pkgs/a/plugins/new/web/index.ts");
    disk.delete("pkgs/a/plugins/new/web/thing.ts");
    expect(await index.refresh(["pkgs/a/plugins/new"])).toBe(true);
    expect(index.tree().byPath.has("a/plugins/new")).toBe(false);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
  });

  test("a hollow shell (only node_modules) is no plugin", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    disk.delete("pkgs/c/core/index.ts");
    expect(await index.refresh(["pkgs/c/core/index.ts"])).toBe(true);
    expect(index.tree().byPath.has("c")).toBe(false);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
  });

  test("a runtime barrel added flips its runtime", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    disk.set("pkgs/c/server/index.ts", barrel("C server"));
    expect(
      await index.refresh(["pkgs/c/server/index.ts", "pkgs/c/server"]),
    ).toBe(true);
    expect(index.tree().byPath.get("c")?.runtimes.server).toBe(true);
    expect(index.tree().byPath.get("c")?.description).toBe("C server");
  });

  test("package.json markers are key-file input", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    disk.set(
      "pkgs/a/package.json",
      JSON.stringify({ equin: { collapsed: true } }),
    );
    const changed = await index.refresh(["pkgs/a/package.json"]);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
    expect(changed).toBe(index.tree().byPath.get("a")?.collapsed === true);
  });

  test("paths outside the plugins root are ignored without a query", async () => {
    const { io, asked } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    asked.length = 0;
    expect(await index.refresh(["README.md", "pkgsX/a.ts"])).toBe(false);
    expect(asked).toEqual([]);
  });

  test("nested paths are asked once, under their outermost folder", async () => {
    const { io, asked } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    asked.length = 0;
    await index.refresh(["pkgs/a/web/index.ts", "pkgs/a", "pkgs/a/web"]);
    expect(asked).toEqual([["pkgs/a"]]);
  });

  test("a refresh of the plugins root itself re-derives everything", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    disk.set("pkgs/d/web/index.ts", barrel("D"));
    disk.delete("pkgs/c/core/index.ts");
    expect(await index.refresh(["pkgs"])).toBe(true);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
  });
});

describe("refresh: edited files", () => {
  test("an edited member asks nothing of the file set", async () => {
    const { disk, io, asked, reads } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    asked.length = 0;
    reads.length = 0;
    disk.set("pkgs/a/web/components/x.tsx", "x2");
    expect(await index.refresh([], ["pkgs/a/web/components/x.tsx"])).toBe(
      false,
    );
    expect(asked).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("an edited key file is re-read without asking the file set", async () => {
    const { disk, io, asked } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    asked.length = 0;
    disk.set("pkgs/a/web/index.ts", barrel("A2"));
    expect(await index.refresh([], ["pkgs/a/web/index.ts"])).toBe(true);
    expect(asked).toEqual([]);
    expect(index.tree().byPath.get("a")?.description).toBe("A2");
  });

  test("an 'edited' file that is no member yet is asked about", async () => {
    const { disk, io } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    disk.set("pkgs/e/web/index.ts", barrel("E"));
    expect(await index.refresh([], ["pkgs/e/web/index.ts"])).toBe(true);
    expect(shape(index.tree())).toEqual(await coldShape(disk));
  });

  test("a .gitignore edit re-asks its folder", async () => {
    const { io, asked } = fakeRepo(BASE);
    const index = await createStructureIndex(ROOT, "pkgs", io);
    asked.length = 0;
    await index.refresh([], ["pkgs/a/.gitignore"]);
    expect(asked).toEqual([["pkgs/a"]]);
  });
});
