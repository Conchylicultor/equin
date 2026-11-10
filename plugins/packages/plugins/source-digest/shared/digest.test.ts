import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineSourceSet } from "../core";
import { computeDigest, sourceDigest } from "./digest";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "source-digest-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write `files` (relative path → text) under `root`. */
async function tree(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

const BASE = {
  "entry.ts": `import { b } from "./b";\nimport type { T } from "./types";\nexport const a = (t: T) => b(t);\n`,
  "b.ts": `import { c } from "./lib/c";\nexport const b = (x: unknown) => c(x);\n`,
  "lib/c.ts": `export const c = (x: unknown) => x;\n`,
  "types.ts": `export type T = string;\n`,
  "unrelated.ts": `export const u = 1;\n`,
};

const digestOf = (root: string) => computeDigest([join(root, "entry.ts")]);

test("a change to a file the entry reaches moves the digest", async () => {
  await tree(dir, BASE);
  const before = await digestOf(dir);
  await tree(dir, { "lib/c.ts": `export const c = (x: unknown) => [x];\n` });
  expect(await digestOf(dir)).not.toBe(before);
});

test("an unrelated file, and a type-only import, do not count", async () => {
  await tree(dir, BASE);
  const before = await digestOf(dir);
  await tree(dir, {
    "unrelated.ts": `export const u = 2;\n`,
    // Erased before anything runs: no edge.
    "types.ts": `export type T = number;\n`,
  });
  expect(await digestOf(dir)).toBe(before);
});

test("the same code at two paths digests equal (main and a worktree agree)", async () => {
  const one = join(dir, "checkout-one", "plugins");
  const two = join(dir, "elsewhere", "checkout-two", "plugins");
  await tree(one, BASE);
  await tree(two, BASE);
  expect(await digestOf(one)).toBe(await digestOf(two));
});

test("a package counts by name@version, a builtin by name", async () => {
  await tree(dir, {
    "entry.ts": `import { join } from "node:path";\nimport { p } from "fake-pkg";\nexport const a = join(p);\n`,
    "node_modules/fake-pkg/package.json": `{"name":"fake-pkg","version":"1.0.0","main":"index.js"}`,
    "node_modules/fake-pkg/index.js": `export const p = "x";\n`,
  });
  const v1 = await digestOf(dir);
  // The package's bytes are not read: only its version moves the digest.
  await tree(dir, {
    "node_modules/fake-pkg/index.js": `export const p = "y";\n`,
  });
  expect(await digestOf(dir)).toBe(v1);
  await tree(dir, {
    "node_modules/fake-pkg/package.json": `{"name":"fake-pkg","version":"1.0.1","main":"index.js"}`,
  });
  expect(await digestOf(dir)).not.toBe(v1);
});

test("a lazy import only a page's import map answers counts by its name", async () => {
  const entry = (host: string) =>
    `export const start = () => import("@browser-host/${host}");\n`;
  await tree(dir, { "entry.ts": entry("a") });
  const a = await digestOf(dir);
  await tree(dir, { "entry.ts": entry("a") });
  expect(await digestOf(dir)).toBe(a);
  await tree(dir, { "entry.ts": entry("b") });
  expect(await digestOf(dir)).not.toBe(a);
});

test("an import that does not resolve throws, naming it", async () => {
  await tree(dir, {
    "entry.ts": `import { x } from "./missing";\nexport const a = x;\n`,
  });
  expect(digestOf(dir)).rejects.toThrow(/cannot resolve "\.\/missing"/);
});

test("an import whose path is not a literal throws: the digest cannot follow it", async () => {
  await tree(dir, {
    "entry.ts": `export const load = (name: string) => import(\`./\${name}\`);\n`,
  });
  expect(digestOf(dir)).rejects.toThrow(
    /1 `import\(…\)` whose path is not a literal/,
  );
});

test("a literal dynamic import is followed; prose and type positions naming import() are not calls", async () => {
  await tree(dir, {
    "entry.ts": `// a lazy import(…) below\nexport type L = typeof import("./lazy");\nexport const load = () => import("./lazy");\n`,
    "lazy.ts": `export const z = 1;\n`,
  });
  const before = await digestOf(dir);
  await tree(dir, { "lazy.ts": `export const z = 2;\n` });
  expect(await digestOf(dir)).not.toBe(before);
});

test("sourceDigest: once per process per module set, and a set with no module throws", async () => {
  await tree(dir, BASE);
  const set = defineSourceSet("test set");
  set.include({ url: pathToFileURL(join(dir, "entry.ts")).href } as ImportMeta);
  const first = await sourceDigest([set]);
  expect(first).toBe(await digestOf(dir));
  // Read once: files edited after describe another process's code.
  await tree(dir, { "lib/c.ts": `export const c = () => 0;\n` });
  expect(await sourceDigest([set])).toBe(first);

  expect(sourceDigest([defineSourceSet("empty set")])).rejects.toThrow(
    /"empty set" includes no module/,
  );
});
