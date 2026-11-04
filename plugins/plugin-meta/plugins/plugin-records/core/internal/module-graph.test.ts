import { describe, expect, test } from "bun:test";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildModuleGraph } from "./module-graph";
import { gitBlobId } from "./keys";
import { createMemoryRecordStore, type RecordStore } from "./store";

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

function snapshotOf(files: Record<string, string>): RepoSnapshot {
  const paths = Object.keys(files).sort();
  return {
    root: asAppPath("/repo"),
    all: () => paths,
    has: (p) => p in files,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: () => {
      throw new Error("unused");
    },
    read: (p) => Promise.resolve(files[p] ?? null),
    blobOf: (p) => {
      const c = files[p];
      if (c === undefined) throw new Error(`not a member: ${p}`);
      return gitBlobId(c);
    },
  };
}

function graphOf(
  files: Record<string, string>,
  entries: string[],
  opts?: { store?: RecordStore; outside?: Record<string, string> },
) {
  return buildModuleGraph(
    {
      snapshot: snapshotOf(files),
      store: opts?.store ?? createMemoryRecordStore(),
      readOutside: (rel) => opts?.outside?.[rel] ?? null,
    },
    entries,
  );
}

const base = {
  [`${P}/a/web/index.ts`]:
    'import { b } from "@plugins/b/core";\nimport "./side";\nexport default {};',
  [`${P}/a/web/side.ts`]: "export {};",
  [`${P}/b/core/index.ts`]: 'export { b } from "./internal/b";',
  [`${P}/b/core/internal/b.ts`]:
    'import type { T } from "../../../c/core";\nexport const b = 1;',
  [`${P}/c/core/index.ts`]: "export type T = 1;",
};

describe("buildModuleGraph", () => {
  test("follows relative and @plugins imports, never type-only ones", async () => {
    const g = await graphOf(base, [`${P}/a/web/index.ts`]);
    expect([...g.modules.keys()].sort()).toEqual([
      `${P}/a/web/index.ts`,
      `${P}/a/web/side.ts`,
      `${P}/b/core/index.ts`,
      `${P}/b/core/internal/b.ts`,
    ]);
    expect([...g.staticClosure(`${P}/a/web/index.ts`)].length).toBe(4);
  });

  test("a module's key moves exactly when something it loads changes", async () => {
    const before = await graphOf(base, [
      `${P}/a/web/index.ts`,
      `${P}/a/web/side.ts`,
    ]);
    const edited = await graphOf(
      { ...base, [`${P}/b/core/internal/b.ts`]: "export const b = 2;" },
      [`${P}/a/web/index.ts`, `${P}/a/web/side.ts`],
    );
    expect(edited.keyOf(`${P}/a/web/index.ts`)).not.toBe(
      before.keyOf(`${P}/a/web/index.ts`),
    );
    expect(edited.keyOf(`${P}/a/web/side.ts`)).toBe(
      before.keyOf(`${P}/a/web/side.ts`),
    );
  });

  test("a cycle shares one key component and still moves with a member", async () => {
    const cyc = {
      "x/a.ts": 'import "./b";',
      "x/b.ts": 'import "./a";',
    };
    const g1 = await graphOf(cyc, ["x/a.ts"]);
    const g2 = await graphOf({ ...cyc, "x/b.ts": 'import "./a";\n// edit' }, [
      "x/a.ts",
    ]);
    expect(g1.keyOf("x/a.ts")).not.toBe(g1.keyOf("x/b.ts"));
    expect(g2.keyOf("x/a.ts")).not.toBe(g1.keyOf("x/a.ts"));
  });

  test("dynamic imports key the module but are not part of its static closure", async () => {
    const files = {
      "x/a.ts": 'export const load = () => import("./lazy");',
      "x/lazy.ts": "export {};",
    };
    const g = await graphOf(files, ["x/a.ts"]);
    expect([...g.staticClosure("x/a.ts")]).toEqual(["x/a.ts"]);
    const edited = await graphOf(
      { ...files, "x/lazy.ts": "export const y = 1;" },
      ["x/a.ts"],
    );
    expect(edited.keyOf("x/a.ts")).not.toBe(g.keyOf("x/a.ts"));
  });

  test("a gitignored module is read from outside the snapshot and keyed by its content", async () => {
    const files = { "x/a.ts": 'import "./gen.generated";' };
    const g1 = await graphOf(files, ["x/a.ts"], {
      outside: { "x/gen.generated.ts": "export const v = 1;" },
    });
    const g2 = await graphOf(files, ["x/a.ts"], {
      outside: { "x/gen.generated.ts": "export const v = 2;" },
    });
    expect(g1.modules.has("x/gen.generated.ts")).toBe(true);
    expect(g2.keyOf("x/a.ts")).not.toBe(g1.keyOf("x/a.ts"));
  });

  test("an unresolved import is part of the key, so the file appearing moves it", async () => {
    const files = { "x/a.ts": 'import "./missing";' };
    const g1 = await graphOf(files, ["x/a.ts"]);
    const g2 = await graphOf({ ...files, "x/missing.ts": "" }, ["x/a.ts"]);
    expect(g1.modules.get("x/a.ts")!.unresolved).toEqual(["./missing"]);
    expect(g2.keyOf("x/a.ts")).not.toBe(g1.keyOf("x/a.ts"));
  });

  test("file facts come from the store: a second build reads no source", async () => {
    const store = createMemoryRecordStore();
    await graphOf(base, [`${P}/a/web/index.ts`], { store });
    const snap = snapshotOf(base);
    let reads = 0;
    await buildModuleGraph(
      {
        snapshot: { ...snap, read: (p) => (reads++, snap.read(p)) },
        store,
        readOutside: () => null,
      },
      [`${P}/a/web/index.ts`],
    );
    expect(reads).toBe(0);
  });
});
