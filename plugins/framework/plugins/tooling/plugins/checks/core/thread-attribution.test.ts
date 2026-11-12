import { afterAll, describe, expect, test } from "bun:test";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackFrame } from "@plugins/infra/plugins/stack-sampler/core";
import {
  classifyLeaf,
  createKindTally,
  createOwnerTally,
  EXAMPLE_FRAMES,
  exampleFrames,
  ownerLabel,
  ownerOf,
  repoRoots,
} from "./thread-attribution";

// Pure: synthetic frames in the three shapes the Bun 1.3.13 probes produced,
// against a fake checkout at `/repo` whose realpath is `/private/repo`.
const ROOTS = ["/repo", "/private/repo"];

function js(name: string, sourceURL: string, line = 1): StackFrame {
  return { name, sourceURL, line, column: 1, category: "JIT" };
}

function native(name: string, category = "native"): StackFrame {
  return { name, sourceURL: null, line: null, column: null, category };
}

const CHECK = "/repo/plugins/database/plugins/migrations/check/index.ts";
const SITES =
  "/repo/plugins/database/plugins/migrations/check/internal/sites.ts";
const RUNNER =
  "/repo/plugins/framework/plugins/tooling/plugins/checks/core/runner.ts";
const TREE =
  "/repo/plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts";

describe("ownerOf", () => {
  test("sync code a check runs itself is the check's (`spin ← checkRun`)", () => {
    expect(
      ownerOf([js("spin", CHECK, 9), js("checkRun", CHECK, 4)], ROOTS),
    ).toEqual({
      kind: "check",
      module: "database/migrations",
    });
  });

  test("a check frame beneath a shared helper and a runner frame still wins", () => {
    const boundaries =
      "/repo/plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts";
    expect(
      ownerOf(
        [js("scanFile", TREE), js("run", boundaries), js("runOne", RUNNER)],
        ROOTS,
      ),
    ).toEqual({
      kind: "check",
      module: "framework/tooling/checks/plugin-boundaries",
    });
  });

  test("an async helper resumed after an await has lost its caller → shared, named by the helper", () => {
    expect(
      ownerOf([js("spin", TREE, 40), js("buildPluginTree", TREE, 12)], ROOTS),
    ).toEqual({
      kind: "shared",
      site: "buildPluginTree @ plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts",
    });
  });

  test("module evaluation → import, keeping the evaluated module's plugin as detail", () => {
    const frames = [
      js("(module)", "/repo/plugins/apps/plugins/mail/core/index.ts"),
      native("evaluate", "Unknown Executable"),
      native("moduleEvaluation"),
      native("requestImportModule"),
    ];
    expect(ownerOf(frames, ROOTS)).toEqual({
      kind: "import",
      plugin: "apps/mail",
    });
  });

  test("a frame under the realpath root, not the plain one, is still attributed", () => {
    expect(
      ownerOf([js("run", "/private/repo/plugins/x/check/index.ts")], ROOTS),
    ).toEqual({ kind: "check", module: "x" });
  });

  test("a frame under neither root is outside the repo, never a check", () => {
    expect(
      ownerOf([js("run", "/elsewhere/plugins/x/check/index.ts")], ROOTS),
    ).toEqual({
      kind: "shared",
      site: "run @ /elsewhere/plugins/x/check/index.ts",
    });
  });

  test("node_modules collapses to the package name, scoped and bun-store nested alike", () => {
    expect(
      ownerOf(
        [
          js("parse", "/repo/node_modules/pg-protocol/dist/parser.js"),
          js("handle", "/repo/node_modules/pg/lib/client.js"),
        ],
        ROOTS,
      ),
    ).toEqual({ kind: "shared", site: "pg" });
    expect(
      ownerOf([js("x", "/repo/node_modules/@scope/lib/index.js")], ROOTS),
    ).toEqual({ kind: "shared", site: "@scope/lib" });
    expect(
      ownerOf(
        [
          js(
            "x",
            "/repo/node_modules/.bun/pg@8.1.0/node_modules/pg/lib/client.js",
          ),
        ],
        ROOTS,
      ),
    ).toEqual({ kind: "shared", site: "pg" });
  });

  test("a repo callback a library dispatches is the work, not the library", () => {
    expect(
      ownerOf(
        [
          js("action", "/repo/plugins/a/core/x.ts"),
          js("_dispatch", "/repo/node_modules/commander/lib/command.js"),
        ],
        ROOTS,
      ),
    ).toEqual({ kind: "shared", site: "action @ plugins/a/core/x.ts" });
  });

  test("a plugin NAMED check is not a check module", () => {
    const run = "/repo/plugins/framework/plugins/cli/plugins/check/cli/run.ts";
    expect(ownerOf([js("action", run)], ROOTS)).toEqual({
      kind: "shared",
      site: "action @ plugins/framework/plugins/cli/plugins/check/cli/run.ts",
    });
  });

  test("native frames only → native, named by the leaf", () => {
    expect(
      ownerOf([native("readFileSync"), native("(anonymous)")], ROOTS),
    ).toEqual({
      kind: "native",
      leaf: "readFileSync [native]",
    });
  });

  const IMPORTING = {
    name: "barrel import",
    detail: "plugins/apps/plugins/mail/web/index.ts",
  };

  test("native frames only, taken during an activity → named by the activity", () => {
    const frames = [
      native("(anonymous)", "Unknown Executable"),
      native("processTicksAndRejections"),
    ];
    expect(ownerOf(frames, ROOTS, IMPORTING)).toEqual({
      kind: "activity",
      name: "barrel import",
      detail: "plugins/apps/plugins/mail/web/index.ts",
    });
  });

  test("a frame that names its owner wins over an activity, which says when, not who", () => {
    expect(ownerOf([js("spin", CHECK, 9)], ROOTS, IMPORTING)).toEqual({
      kind: "check",
      module: "database/migrations",
    });
    expect(ownerOf([js("spin", TREE, 40)], ROOTS, IMPORTING).kind).toBe(
      "shared",
    );
  });
});

describe("repoRoots", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "thread-roots-")));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("a checkout reached through a symlink yields both spellings", () => {
    const real = join(scratch, "real");
    const link = join(scratch, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(repoRoots(asAppPath(link))).toEqual([link, real]);
    expect(repoRoots(asAppPath(real))).toEqual([real]);
  });
});

describe("ownerLabel", () => {
  test("an import's plugin is detail, not identity", () => {
    expect(ownerLabel({ kind: "import", plugin: "a" })).toBe("import");
    expect(ownerLabel({ kind: "import", plugin: "b" })).toBe("import");
    expect(ownerLabel({ kind: "check", module: "x" })).toBe("check x");
  });

  test("an activity's instance is detail too", () => {
    expect(
      ownerLabel({ kind: "activity", name: "barrel import", detail: "a" }),
    ).toBe("native during barrel import");
  });
});

describe("exampleFrames", () => {
  test("a short stack is kept whole", () => {
    expect(
      exampleFrames([native("statSync"), js("run", CHECK, 3)], ROOTS),
    ).toEqual([
      "statSync [native]",
      "run @ plugins/database/plugins/migrations/check/index.ts:3",
    ]);
  });

  test("a repo frame below the depth is reached through a `… N frames` marker", () => {
    const ts = "/repo/node_modules/typescript/lib/typescript.js";
    const frames = [
      native("readdirSync"),
      ...Array.from({ length: 12 }, (_, i) => js(`visit${i}`, ts, i)),
      js("repoCompilerOptions", SITES, 526),
      js("scan", SITES, 70),
      js("run", CHECK, 57),
    ];
    const example = exampleFrames(frames, ROOTS);
    // Head 2 + marker + the 3 frames from the repo frame out (room for 5).
    expect(example.length).toBeLessThanOrEqual(EXAMPLE_FRAMES);
    expect(example).toHaveLength(6);
    expect(example.slice(0, 4)).toEqual([
      "readdirSync [native]",
      "visit0 @ node_modules/typescript/lib/typescript.js:0",
      "… 11 frames",
      "repoCompilerOptions @ plugins/database/plugins/migrations/check/internal/sites.ts:526",
    ]);
    expect(example.at(-1)).toBe(
      "run @ plugins/database/plugins/migrations/check/index.ts:57",
    );
  });
});

describe("createOwnerTally", () => {
  test("counts per owner, keeps a sample's stack shortened, and pools import detail", () => {
    const tally = createOwnerTally(ROOTS);
    const checkStack = [js("spin", CHECK, 9), js("checkRun", CHECK, 4)];
    tally.add({ kind: "check", module: "database/migrations" }, checkStack);
    tally.add({ kind: "check", module: "database/migrations" }, [
      js("other", CHECK, 20),
    ]);
    tally.add({ kind: "import", plugin: "apps/mail" }, [
      native("moduleEvaluation"),
    ]);
    tally.add({ kind: "import", plugin: "apps/mail" }, [
      native("moduleEvaluation"),
    ]);
    tally.add({ kind: "import", plugin: "pages" }, [
      native("moduleEvaluation"),
    ]);

    expect(tally.samples).toBe(5);
    // Busiest first: the three import samples outrank the two check samples.
    const [imports, check] = tally.top(10);
    expect(check).toEqual({
      owner: "check database/migrations",
      samples: 2,
      example: [
        "spin @ plugins/database/plugins/migrations/check/index.ts:9",
        "checkRun @ plugins/database/plugins/migrations/check/index.ts:4",
      ],
      // Two paths of one sample each: a tie keeps the first seen.
      exampleSamples: 1,
      detail: [],
    });
    expect(imports?.owner).toBe("import");
    expect(imports?.detail).toEqual([
      { name: "apps/mail", samples: 2 },
      { name: "pages", samples: 1 },
    ]);
    expect(tally.top(1)).toHaveLength(1);
  });

  test("the example is the owner's BUSIEST path, not its first sample", () => {
    // report-1794164673-6le9e5's shape: the check's first sample was a short
    // regex match at its top level; most of its samples were a directory walk
    // further down, on lines that vary from sample to sample.
    const tally = createOwnerTally(ROOTS);
    const owner = { kind: "check", module: "database/migrations" } as const;
    tally.add(owner, [native("match"), js("run", CHECK, 51)]);
    for (const line of [10, 11, 12])
      tally.add(owner, [
        native("readdirSync"),
        js("walk", SITES, line),
        js("run", CHECK, 57),
      ]);
    const [share] = tally.top(1);
    expect(share?.samples).toBe(4);
    expect(share?.exampleSamples).toBe(3);
    expect(share?.example[0]).toBe("readdirSync [native]");
  });

  test("pools an activity's instances as detail under one owner", () => {
    const tally = createOwnerTally(ROOTS);
    const frames = [native("(anonymous)", "Unknown Executable")];
    for (const detail of [
      "a/web/index.ts",
      "a/web/index.ts",
      "b/web/index.ts",
    ]) {
      tally.add({ kind: "activity", name: "barrel import", detail }, frames);
    }
    const [share] = tally.top(10);
    expect(share?.owner).toBe("native during barrel import");
    expect(share?.detail).toEqual([
      { name: "a/web/index.ts", samples: 2 },
      { name: "b/web/index.ts", samples: 1 },
    ]);
  });
});

describe("classifyLeaf", () => {
  test("a native `*Sync` frame → blocking-io, no matter the function name", () => {
    expect(classifyLeaf(native("readdirSync"))).toBe("blocking-io");
    expect(classifyLeaf(native("__scanSync"))).toBe("blocking-io");
    expect(classifyLeaf(native("mkdtempSync"))).toBe("blocking-io");
  });

  test("Bun's spawn machinery → process, checked before the `Sync` pattern", () => {
    expect(classifyLeaf(native("spawn"))).toBe("process");
    expect(classifyLeaf(native("spawnSync"))).toBe("process");
    expect(classifyLeaf(native("posix_spawn"))).toBe("process");
    expect(classifyLeaf(native("resourceUsage"))).toBe("process");
  });

  test("the module loader's own frames → module-load", () => {
    expect(classifyLeaf(native("require"))).toBe("module-load");
    expect(classifyLeaf(native("requestInstantiate"))).toBe("module-load");
    expect(classifyLeaf(native("fetch"))).toBe("module-load");
    expect(classifyLeaf(native("parseModule"))).toBe("module-load");
    expect(classifyLeaf(js("(module)", CHECK))).toBe("module-load");
  });

  test("an unmatched name with a source file → cpu", () => {
    expect(classifyLeaf(js("maskSource", TREE))).toBe("cpu");
  });

  test("an unmatched native name with no source → native, never dropped", () => {
    expect(classifyLeaf(native("readFile"))).toBe("native");
    expect(classifyLeaf(native("anonymous"))).toBe("native");
  });
});

describe("createKindTally", () => {
  test("counts per kind, zero-filled, and keeps the busiest raw leaves", () => {
    const tally = createKindTally(ROOTS);
    tally.add([native("readdirSync")]);
    tally.add([native("readdirSync")]);
    tally.add([native("spawn")]);
    tally.add([js("maskSource", CHECK, 9)]);

    expect(tally.samples).toBe(4);
    expect(tally.counts()).toEqual({
      "blocking-io": 2,
      process: 1,
      "module-load": 0,
      cpu: 1,
      native: 0,
    });
    expect(tally.topLeaves(10)).toEqual([
      { leaf: "readdirSync [native]", samples: 2 },
      { leaf: "spawn [native]", samples: 1 },
      {
        leaf: "maskSource @ plugins/database/plugins/migrations/check/index.ts:9",
        samples: 1,
      },
    ]);
    expect(tally.topLeaves(1)).toHaveLength(1);
  });

  test("no frames at all still counts as one (native) sample, never dropped", () => {
    const tally = createKindTally(ROOTS);
    tally.add([]);
    expect(tally.samples).toBe(1);
    expect(tally.counts().native).toBe(1);
    expect(tally.topLeaves(10)).toEqual([{ leaf: "(no frames)", samples: 1 }]);
  });
});
