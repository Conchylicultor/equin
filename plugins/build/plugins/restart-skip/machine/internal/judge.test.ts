import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closureChangedSince } from "@plugins/packages/plugins/source-digest/server";
import type { AdoptRequest } from "../../core";
import { judgeAdoption, type ProcessView } from "../../shared/judge";

// The skip decision must be exact: a wrong `adopted` leaves a backend running
// old code under a deploy that claims new code, far worse than an extra
// restart. Each case is a process that "started" over a temp checkout, then
// something moved on disk.

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "restart-skip-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const at = (rel: string) => join(root, rel);

async function write(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(at(rel)), { recursive: true });
    await writeFile(at(rel), text);
  }
}

const CHECKOUT = {
  "bun-clone": "#!binary v1\n",
  "bin/index.ts": `import { a } from "../app/a";\nimport { p } from "fake-pkg";\nexport const run = () => [a, p];\nexport const later = () => import("../app/lazy");\n`,
  "app/a.ts": `export const a = 1;\n`,
  "app/lazy.ts": `export const lazy = 1;\n`,
  "web/page.tsx": `export const Page = () => null;\n`,
  "node_modules/fake-pkg/package.json": `{"name":"fake-pkg","version":"1.0.0","main":"index.js"}`,
  "node_modules/fake-pkg/index.js": `export const p = 1;\n`,
  "migrations/0001.sql": `create table t (id int);\n`,
  "tsconfig.json": `{}\n`,
  "worker/entry.ts": `import { w } from "./lib";\nexport const run = () => w;\n`,
  "worker/lib.ts": `export const w = 1;\n`,
};

/** A process that started over the checkout as written so far, having loaded `loaded`. */
async function startProcess(loaded: string[]): Promise<ProcessView> {
  await Bun.sleep(5);
  const startedAtMs = Date.now();
  await Bun.sleep(5);
  return {
    startedAtMs,
    bin: at("bun-clone"),
    entry: at("bin/index.ts"),
    loaded: loaded.map(at),
    runtimeInputs: [at("tsconfig.json")],
    bootInputs: [{ what: "the migration SQL", paths: [at("migrations")] }],
    children: [],
    closureSince: closureChangedSince,
  };
}

const deploy = (over: Partial<AdoptRequest> = {}): AdoptRequest => ({
  bin: at("bun-clone"),
  entry: at("bin/index.ts"),
  commit: "abc123",
  ...over,
});

/** What the eager boot loaded: the static closure (the entry itself is not a loader key). */
const EAGER = ["app/a.ts", "node_modules/fake-pkg/index.js"];

test("nothing moved: adopted", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  expect(await judgeAdoption(p, deploy())).toEqual({ kind: "adopted" });
});

test("a web-only change (outside the backend's closure): adopted", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  await write({ "web/page.tsx": `export const Page = () => "new";\n` });
  expect(await judgeAdoption(p, deploy())).toEqual({ kind: "adopted" });
});

test("an edit inside a lazily imported module not loaded yet: restart", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  await write({ "app/lazy.ts": `export const lazy = 2;\n` });
  const v = await judgeAdoption(p, deploy());
  expect(v.kind).toBe("restart");
  expect(v.kind === "restart" && v.reason).toContain("app/lazy.ts");
});

test("a lazily loaded module changed and reverted to the bytes it had: restart", async () => {
  await write(CHECKOUT);
  // It was loaded while it held other bytes; the tree ends where it began.
  const p = await startProcess([...EAGER, "app/lazy.ts"]);
  await write({ "app/lazy.ts": `export const lazy = 2;\n` });
  await write({ "app/lazy.ts": CHECKOUT["app/lazy.ts"] });
  const v = await judgeAdoption(p, deploy());
  expect(v.kind).toBe("restart");
  expect(v.kind === "restart" && v.reason).toContain("a loaded module");
});

test("an eagerly loaded module rewritten with equal bytes: restart", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  await write({ "app/a.ts": CHECKOUT["app/a.ts"] });
  expect((await judgeAdoption(p, deploy())).kind).toBe("restart");
});

test("a loaded package file replaced: restart", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  await write({ "node_modules/fake-pkg/index.js": `export const p = 2;\n` });
  const v = await judgeAdoption(p, deploy());
  expect(v.kind === "restart" && v.reason).toContain("fake-pkg/index.js");
});

test("a new migration: restart", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  await write({ "migrations/0002.sql": `alter table t add x int;\n` });
  const v = await judgeAdoption(p, deploy());
  expect(v.kind === "restart" && v.reason).toContain("migration SQL");
});

test("a resolution input (tsconfig) touched: restart", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  await write({ "tsconfig.json": `{}\n` });
  expect((await judgeAdoption(p, deploy())).kind).toBe("restart");
});

test("another Bun, or the same path re-cloned: restart", async () => {
  await write({ ...CHECKOUT, "other-bun": "#!binary v2\n" });
  const p = await startProcess(EAGER);
  expect((await judgeAdoption(p, deploy({ bin: at("other-bun") }))).kind).toBe(
    "restart",
  );
  await write({ "bun-clone": "#!binary v2\n" });
  const v = await judgeAdoption(p, deploy());
  expect(v.kind === "restart" && v.reason).toContain("the Bun binary");
});

test("another entry (another composition): restart", async () => {
  await write({ ...CHECKOUT, "bin/other.ts": `export {};\n` });
  const p = await startProcess(EAGER);
  expect(
    (await judgeAdoption(p, deploy({ entry: at("bin/other.ts") }))).kind,
  ).toBe("restart");
});

test("a loaded module the closure no longer reaches: restart", async () => {
  await write({ ...CHECKOUT, "app/old.ts": `export const old = 1;\n` });
  const p = await startProcess([...EAGER, "app/old.ts"]);
  const v = await judgeAdoption(p, deploy());
  expect(v.kind === "restart" && v.reason).toContain("no longer reaches");
});

test("a closure the digest cannot follow: cannot-judge — a defect the deploy reports, not a quiet restart", async () => {
  await write({
    ...CHECKOUT,
    "app/lazy.ts": `const n = "./a";\nexport const lazy = () => import(n);\n`,
  });
  const p = await startProcess(EAGER);
  const v = await judgeAdoption(p, deploy());
  expect(v.kind === "cannot-judge" && v.reason).toContain("cannot be measured");
});

/** The process started a worker on `worker/entry.ts`, spawned "now". */
async function withWorker(p: ProcessView): Promise<ProcessView> {
  await Bun.sleep(5);
  const spawnedAtMs = Date.now();
  await Bun.sleep(5);
  return {
    ...p,
    children: [
      {
        label: "test.worker",
        spawnedAtMs,
        code: { binary: null, entries: [at("worker/entry.ts")] },
      },
    ],
  };
}

test("a live worker whose code is untouched since it spawned: adopted", async () => {
  await write(CHECKOUT);
  const p = await withWorker(await startProcess(EAGER));
  expect(await judgeAdoption(p, deploy())).toEqual({ kind: "adopted" });
});

test("an edit in a live worker's code — outside the backend's own closure: restart", async () => {
  await write(CHECKOUT);
  const p = await withWorker(await startProcess(EAGER));
  await write({ "worker/lib.ts": `export const w = 2;\n` });
  const v = await judgeAdoption(p, deploy());
  expect(v.kind === "restart" && v.reason).toContain("the child test.worker");
  expect(v.kind === "restart" && v.reason).toContain("worker/lib.ts");
});

test("a live child whose code cannot be pointed at: restart", async () => {
  await write(CHECKOUT);
  const p = await startProcess(EAGER);
  const v = await judgeAdoption(
    {
      ...p,
      children: [
        {
          label: "test.python",
          spawnedAtMs: p.startedAtMs,
          code: { binary: at("bun-clone"), entries: null },
        },
      ],
    },
    deploy(),
  );
  expect(v.kind === "restart" && v.reason).toContain("cannot point at");
});

test("a lazy import only a page's import map answers (a demo's browser host): adopted", async () => {
  await write({
    ...CHECKOUT,
    "app/a.ts": `export const a = 1;\nexport const host = () => import("@browser-host/apps/plugins/demo");\n`,
  });
  const p = await startProcess(EAGER);
  expect(await judgeAdoption(p, deploy())).toEqual({ kind: "adopted" });
});
