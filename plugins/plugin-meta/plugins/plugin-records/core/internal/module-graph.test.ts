import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { buildModuleGraph, NO_OUTSIDE_FILES } from "./module-graph";
import { fileSetImports, fileSetRuntimeReach } from "./file-set-closure";
import { gitBlobId } from "./keys";
import { createMemoryRecordStore, type RecordStore } from "./store";

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

// The file-facts scan, as a checkout holds it. Every graph keys its facts by
// this module's Merkle key, read from the checkout the scan runs from: a
// fixture of its own (root `/repo`) needs no copy of it, and one standing for
// that checkout (`code: true` — its root, the scan's module in it) keys its
// facts by its own copy and its own lockfile, as the checkout's build does.
const SCAN = readFileSync(join(import.meta.dir, "scan-imports.ts"), "utf8");
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";

function snapshotOf(
  fixture: Record<string, string>,
  opts?: { code?: boolean },
): RepoSnapshot {
  const files: Record<string, string> = opts?.code
    ? { [SCAN_PATH]: SCAN, ...fixture }
    : fixture;
  const paths = Object.keys(files).sort();
  return {
    root: opts?.code ? REPO_ROOT : asAppPath("/repo"),
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
  opts?: {
    store?: RecordStore;
    outside?: Record<string, string>;
    code?: boolean;
  },
) {
  return buildModuleGraph(
    {
      snapshot: snapshotOf(files, { code: opts?.code ?? false }),
      store: opts?.store ?? createMemoryRecordStore(),
      readOutside: async (rel) => opts?.outside?.[rel] ?? null,
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

  test("a bundled closure follows exactly the dynamic edges the caller picks, and lists the bare specifiers it keeps", async () => {
    const files = {
      "x/a.ts": [
        'import { s } from "./s";',
        'import type { T } from "./t";',
        'import "pkg-static";',
        'import { unused } from "pkg-unused";',
        'export const lazy = () => import("./lazy");',
        'export const cmd = () => import("./cmd");',
        'export const npm = () => import("pkg-dynamic");',
        "export const v: T = s;",
      ].join("\n"),
      "x/s.ts": "export const s = 1;",
      "x/t.ts": "export type T = number;",
      "x/lazy.ts": 'import "./deep";\nexport {};',
      "x/deep.ts": "export {};",
      "x/cmd.ts": "export {};",
    };
    const g = await graphOf(files, ["x/a.ts"]);
    expect(g.modules.get("x/a.ts")!.dynamicImports).toEqual([
      { spec: "./lazy", target: "x/lazy.ts" },
      { spec: "./cmd", target: "x/cmd.ts" },
    ]);

    const cut = g.bundledClosure(["x/a.ts"]);
    expect([...cut.modules].sort()).toEqual(["x/a.ts", "x/s.ts"]);
    // Kept static bare imports only: a type-erased or unused one is not loaded.
    expect([...cut.external.keys()]).toEqual(["pkg-static"]);

    const followed = g.bundledClosure(["x/a.ts"], {
      followDynamic: (module, spec) =>
        !(module === "x/a.ts" && spec === "./cmd"),
    });
    expect([...followed.modules].sort()).toEqual([
      "x/a.ts",
      "x/deep.ts",
      "x/lazy.ts",
      "x/s.ts",
    ]);
    expect(followed.children("x/a.ts")).toEqual(["x/lazy.ts", "x/s.ts"]);
    expect(followed.importChain("x/deep.ts")).toEqual([
      "x/a.ts",
      "x/lazy.ts",
      "x/deep.ts",
    ]);
    expect([...followed.external.keys()].sort()).toEqual([
      "pkg-dynamic",
      "pkg-static",
    ]);
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

  test("calls over one input grow one graph: same keys as one walk, each view its own closure", async () => {
    const files = {
      ...base,
      "x/cyc-a.ts": 'import "./cyc-b";\nimport "@plugins/b/core";',
      "x/cyc-b.ts": 'import "./cyc-a";',
      "x/top.ts": 'import "./cyc-a";\nexport const t = () => import("./lazy");',
      "x/lazy.ts": 'import "@plugins/a/web";',
    };
    const all = [`${P}/a/web/index.ts`, "x/top.ts"];
    const once = await graphOf(files, all);

    const input = {
      snapshot: snapshotOf(files),
      store: createMemoryRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    };
    // Grown leaf-first, so later walks reach modules (and a cycle's members)
    // keyed by an earlier call.
    const first = await buildModuleGraph(input, [`${P}/b/core/index.ts`]);
    const second = await buildModuleGraph(input, ["x/cyc-b.ts"]);
    const third = await buildModuleGraph(input, all);
    for (const m of once.modules.keys())
      expect(third.keyOf(m)).toBe(once.keyOf(m));
    expect([...third.modules.keys()].sort()).toEqual(
      [...once.modules.keys()].sort(),
    );
    // An earlier view is exactly its own closure, and refuses what is not in it.
    expect([...first.modules.keys()].sort()).toEqual([
      `${P}/b/core/index.ts`,
      `${P}/b/core/internal/b.ts`,
    ]);
    expect(() => first.keyOf("x/top.ts")).toThrow(/not in the module graph/);
    expect(second.keyOf("x/cyc-a.ts")).toBe(once.keyOf("x/cyc-a.ts"));
  });

  test("a walk that throws leaves the shared graph usable", async () => {
    const input = {
      snapshot: snapshotOf(base),
      store: createMemoryRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    };
    expect(buildModuleGraph(input, ["x/none.ts"])).rejects.toThrow(
      /does not exist/,
    );
    const g = await buildModuleGraph(input, [`${P}/a/web/index.ts`]);
    expect(g.keyOf(`${P}/a/web/index.ts`)).toBe(
      (await graphOf(base, [`${P}/a/web/index.ts`])).keyOf(
        `${P}/a/web/index.ts`,
      ),
    );
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
    const reads: string[] = [];
    await buildModuleGraph(
      {
        snapshot: { ...snap, read: (p) => (reads.push(p), snap.read(p)) },
        store,
        readOutside: async () => null,
      },
      [`${P}/a/web/index.ts`],
    );
    // The facts' identity is the scan's Merkle key, read from the checkout the
    // scan runs from — never from this fixture, which holds no copy of it.
    expect(reads).toEqual([]);
  });

  test("editing the scan re-keys every file fact", async () => {
    const store = createMemoryRecordStore();
    const entries = [`${P}/a/web/index.ts`];
    await graphOf(base, entries, { store, code: true });
    const edited = snapshotOf(
      { ...base, [SCAN_PATH]: `${SCAN}\n// edited` },
      { code: true },
    );
    const reads: string[] = [];
    await buildModuleGraph(
      {
        snapshot: { ...edited, read: (p) => (reads.push(p), edited.read(p)) },
        store,
        readOutside: async () => null,
      },
      entries,
    );
    expect(reads).toContain(`${P}/a/web/index.ts`);
  });

  test("a set that is not the scan's checkout keys its facts by the running scan", async () => {
    const store = createMemoryRecordStore();
    const entries = [`${P}/a/web/index.ts`];
    await graphOf(base, entries, { store });
    // The fixture's own copy of the scan, edited, is data: it keys nothing.
    const reads: string[] = [];
    const snap = snapshotOf({ ...base, [SCAN_PATH]: `${SCAN}\n// edited` });
    await buildModuleGraph(
      {
        snapshot: { ...snap, read: (p) => (reads.push(p), snap.read(p)) },
        store,
        readOutside: async () => null,
      },
      entries,
    );
    expect(reads).toEqual([]);
  });
});

describe("the lockfile in the file-facts key", () => {
  // The shape bun writes, trimmed: a workspaces section, then packages, where
  // a workspace package's line names `@workspace:`.
  const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "repo",
    },
  },
  "packages": {
    "zod": ["zod@4.0.0", "", {}, "sha512-x"],
  }
}
`;
  // A plugin added: its workspace stanza and its link line, nothing installed.
  const PLUGIN_ADDED = LOCK.replace(
    `  },\n  "packages": {`,
    `    "plugins/c": {\n      "name": "@equin/plugin-c",\n      "version": "0.0.1",\n    },\n  },\n  "packages": {\n    "@equin/plugin-c": ["@equin/plugin-c@workspace:plugins/c"],\n`,
  );
  const NPM_BUMPED = LOCK.replace("zod@4.0.0", "zod@4.0.1");

  function writes(): { store: RecordStore; written: () => number } {
    const store = createMemoryRecordStore();
    let n = 0;
    return {
      store: {
        ...store,
        putMany(table, entries) {
          if (table === "file") n += entries.length;
          store.putMany(table, entries);
        },
      },
      written: () => n,
    };
  }

  test("a plugin added to bun.lock re-keys no file record", async () => {
    expect(PLUGIN_ADDED).not.toBe(LOCK);
    const { store, written } = writes();
    const entries = [`${P}/a/web/index.ts`];
    await graphOf({ ...base, "bun.lock": LOCK }, entries, {
      store,
      code: true,
    });
    const first = written();
    expect(first).toBeGreaterThan(0);
    await graphOf({ ...base, "bun.lock": PLUGIN_ADDED }, entries, {
      store,
      code: true,
    });
    expect(written()).toBe(first);
  });

  test("an npm resolution change re-keys no file record: the facts scan loads no package", async () => {
    const { store, written } = writes();
    const entries = [`${P}/a/web/index.ts`];
    await graphOf({ ...base, "bun.lock": LOCK }, entries, {
      store,
      code: true,
    });
    const first = written();
    await graphOf({ ...base, "bun.lock": NPM_BUMPED }, entries, {
      store,
      code: true,
    });
    expect(written()).toBe(first);
  });
});

describe("fileSetImports", () => {
  test("each module's runtime repo imports: type-only erased, assets and npm aside", async () => {
    const snap = snapshotOf({
      [`${P}/a/web/index.ts`]: [
        'import { b } from "@plugins/b/core";',
        'import type { T } from "@plugins/t/core";',
        'import { type U } from "@plugins/t/core";',
        'import "./style.css";',
        'import React from "react";',
        'const lazy = () => import("@plugins/c/core");',
        "export const x = [b, React, lazy];",
      ].join("\n"),
      [`${P}/a/web/style.css`]: "",
      [`${P}/b/core/index.ts`]: "export const b = 1;",
      [`${P}/c/core/index.ts`]: "export const c = 1;",
      [`${P}/t/core/index.ts`]: "export type T = 1; export type U = 2;",
    });
    expect(await fileSetImports(snap, [`${P}/a/web/index.ts`])).toEqual(
      new Map([[`${P}/a/web/index.ts`, [`${P}/b/core/index.ts`]]]),
    );
  });

  test("an import that resolves to no file throws, naming the module", async () => {
    const snap = snapshotOf({
      [`${P}/a/web/index.ts`]:
        'import { b } from "@plugins/b/core";\nexport const x = b;',
    });
    expect(fileSetImports(snap, [`${P}/a/web/index.ts`])).rejects.toThrow(
      `${P}/a/web/index.ts imports "@plugins/b/core"`,
    );
  });
});

describe("fileSetRuntimeReach", () => {
  test("follows runtime and dynamic imports, each module mapped to who first reached it", async () => {
    const snap = snapshotOf({
      [`${P}/a/server/index.ts`]: [
        'import { b } from "@plugins/b/core";',
        'import type { T } from "@plugins/t/core";',
        'import { u } from "@plugins/u/core";',
        'import "./style.css";',
        'export const y = () => import("@plugins/c/core");',
        "export const x = b;",
        "export type V = typeof u;",
      ].join("\n"),
      [`${P}/a/server/style.css`]: "",
      [`${P}/b/core/index.ts`]: 'export { b } from "./internal/b";',
      [`${P}/b/core/internal/b.ts`]: "export const b = 1;",
      [`${P}/c/core/index.ts`]: "export const c = 1;",
      [`${P}/t/core/index.ts`]: "export type T = 1;",
      [`${P}/u/core/index.ts`]: "export const u = 1;",
    });
    const reach = await fileSetRuntimeReach(snap, [`${P}/a/server/index.ts`]);
    expect(reach).toEqual(
      new Map([
        [`${P}/a/server/index.ts`, null],
        // An import used only in a type position still loads.
        [`${P}/b/core/index.ts`, `${P}/a/server/index.ts`],
        [`${P}/u/core/index.ts`, `${P}/a/server/index.ts`],
        [`${P}/c/core/index.ts`, `${P}/a/server/index.ts`],
        [`${P}/b/core/internal/b.ts`, `${P}/b/core/index.ts`],
      ]),
    );
  });

  test("an unresolved import of a reached module throws, naming it", async () => {
    const snap = snapshotOf({
      [`${P}/a/server/index.ts`]: 'export { b } from "@plugins/b/core";',
      [`${P}/b/core/index.ts`]: 'export { b } from "./gone";',
    });
    expect(
      fileSetRuntimeReach(snap, [`${P}/a/server/index.ts`]),
    ).rejects.toThrow(`${P}/b/core/index.ts imports "./gone"`);
  });
});
