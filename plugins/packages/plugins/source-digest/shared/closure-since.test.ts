import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closureChangedSince } from "./digest";

// What a running process's restart-skip rests on (`build/restart-skip`): a
// closure whose every file — eager or lazily imported — and every package
// resolution entry predates the process start is exactly what it loaded.

let dir: string;

beforeEach(async () => {
  // Real path: resolution answers real paths (macOS's tmpdir is a symlink).
  dir = await realpath(await mkdtemp(join(tmpdir(), "closure-since-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tree(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

const BASE = {
  "entry.ts": `import { b } from "./b";\nimport type { T } from "./types";\nexport const a = (t: T) => b(t);\nexport const later = () => import("./lazy");\n`,
  "b.ts": `import { c } from "./lib";\nexport const b = (x: unknown) => c(x);\n`,
  "lib/index.ts": `export const c = (x: unknown) => x;\n`,
  "lazy.ts": `export const z = 1;\n`,
  "types.ts": `export type T = string;\n`,
  "unrelated.ts": `export const u = 1;\n`,
};

/** "The process started now": an instant every file written so far precedes. */
async function started(): Promise<number> {
  await Bun.sleep(5);
  const at = Date.now();
  await Bun.sleep(5);
  return at;
}

const since = (at: number) => closureChangedSince([join(dir, "entry.ts")], at);

test("an untouched closure is unchanged, and lists every file it reaches, lazy ones included", async () => {
  await tree(BASE);
  const at = await started();
  const r = await since(at);
  expect(r.kind).toBe("unchanged");
  if (r.kind !== "unchanged") return;
  expect([...r.files].map((f) => f.slice(dir.length + 1)).sort()).toEqual([
    "b.ts",
    "entry.ts",
    "lazy.ts",
    "lib/index.ts",
  ]);
});

test("an edit inside a lazily imported module is a change", async () => {
  await tree(BASE);
  const at = await started();
  await tree({ "lazy.ts": `export const z = 2;\n` });
  const r = await since(at);
  expect(r).toMatchObject({ kind: "changed", path: join(dir, "lazy.ts") });
});

test("a revert — the same bytes written back — is still a change", async () => {
  await tree(BASE);
  const at = await started();
  await tree({ "lib/index.ts": `export const c = (x: unknown) => [x];\n` });
  await tree({ "lib/index.ts": BASE["lib/index.ts"] });
  const r = await since(at);
  expect(r).toMatchObject({ kind: "changed", path: join(dir, "lib/index.ts") });
});

test("a file outside the closure, or reached only by a type-only import, is no change", async () => {
  await tree(BASE);
  const at = await started();
  await tree({
    "unrelated.ts": `export const u = 2;\n`,
    "types.ts": `export type T = number;\n`,
  });
  expect((await since(at)).kind).toBe("unchanged");
});

test("a new file shadowing a resolution is a change, though no old file moved", async () => {
  await tree(BASE);
  const at = await started();
  // `./lib` now resolves to lib.ts ahead of lib/index.ts.
  await tree({ "lib.ts": `export const c = (x: unknown) => [x, x];\n` });
  const r = await since(at);
  expect(r).toMatchObject({ kind: "changed", path: join(dir, "lib.ts") });
});

test("a package symlink re-pointed at an older, pre-existing store dir is a change", async () => {
  await tree({
    "entry.ts": `import { p } from "fake-pkg";\nexport const a = p;\n`,
    "node_modules/.store/fake-pkg@1/node_modules/fake-pkg/package.json": `{"name":"fake-pkg","version":"1.0.0","main":"index.js"}`,
    "node_modules/.store/fake-pkg@1/node_modules/fake-pkg/index.js": `export const p = 1;\n`,
    "node_modules/.store/fake-pkg@2/node_modules/fake-pkg/package.json": `{"name":"fake-pkg","version":"2.0.0","main":"index.js"}`,
    "node_modules/.store/fake-pkg@2/node_modules/fake-pkg/index.js": `export const p = 2;\n`,
  });
  const link = join(dir, "node_modules", "fake-pkg");
  await symlink(".store/fake-pkg@2/node_modules/fake-pkg", link);
  const at = await started();
  expect((await since(at)).kind).toBe("unchanged");
  // A downgrade: every file of the version now resolved predates the start.
  await unlink(link);
  await symlink(".store/fake-pkg@1/node_modules/fake-pkg", link);
  const r = await since(at);
  expect(r).toMatchObject({ kind: "changed", path: link });
});

test("a closure holding a computed load is unmeasurable", async () => {
  await tree({
    "entry.ts": `const name = "./b";\nexport const later = () => import(name);\n`,
  });
  const at = await started();
  expect((await since(at)).kind).toBe("unmeasurable");
});
