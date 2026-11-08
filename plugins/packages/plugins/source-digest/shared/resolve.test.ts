import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createImportResolver, UnresolvedImportError } from "./resolve";

// The resolver answers what `Bun.resolveSync` would, without holding the
// thread. This holds it to that, import by import, over the closures the
// digest walks in production: a serving backend's and central's entries.

const ROOT = join(import.meta.dir, "../../../../..");
const ENTRIES = [
  "plugins/framework/plugins/server-core/bin/index.ts",
  "plugins/framework/plugins/central-core/bin/index.ts",
];
const BUILTINS = new Set(builtinModules);
const NODE_MODULES = `${sep}node_modules${sep}`;

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
};

function scan(path: string, text: string): string[] {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return [];
  const t = path.endsWith(".tsx")
    ? transpilers.tsx
    : /\.[cm]?ts$/.test(path)
      ? transpilers.ts
      : transpilers.js;
  return t.scanImports(text).map((i) => i.path);
}

const isBuiltin = (s: string) =>
  s === "bun" ||
  s.startsWith("bun:") ||
  s.startsWith("node:") ||
  BUILTINS.has(s);

/** The real package directory Bun's answer lies in. */
function packageDirOf(resolved: string): string {
  const at = resolved.lastIndexOf(NODE_MODULES) + NODE_MODULES.length;
  const segments = resolved.slice(at).split(sep);
  const name = segments[0]!.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0]!;
  return resolved.slice(0, at) + name.split("/").join(sep);
}

test("agrees with Bun.resolveSync on every import of a backend's and central's closure", async () => {
  const resolver = createImportResolver();
  const seen = new Set(ENTRIES.map((e) => join(ROOT, e)));
  const queue = [...seen];
  const disagreements: string[] = [];
  let imports = 0;
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const specifier of scan(file, await readFile(file, "utf8"))) {
      if (isBuiltin(specifier)) continue;
      imports++;
      let bun: string;
      try {
        bun = Bun.resolveSync(specifier, dirname(file));
      } catch (err) {
        if (!String(err).includes("Cannot find")) throw err;
        // The runtime cannot resolve it: neither may the resolver.
        expect(
          Promise.resolve().then(() => resolver.resolve(specifier, file)),
        ).rejects.toThrow(UnresolvedImportError);
        continue;
      }
      const ours = await resolver.resolve(specifier, file);
      if (bun.includes(NODE_MODULES)) {
        const expected = packageDirOf(bun);
        if (ours.kind !== "package" || ours.dir !== expected) {
          disagreements.push(
            `${specifier} from ${file}: bun ${expected}, ours ${JSON.stringify(ours)}`,
          );
        }
        continue;
      }
      if (ours.kind !== "file" || ours.path !== bun) {
        disagreements.push(
          `${specifier} from ${file}: bun ${bun}, ours ${JSON.stringify(ours)}`,
        );
        continue;
      }
      if (!seen.has(bun)) {
        seen.add(bun);
        queue.push(bun);
      }
    }
  }
  expect(disagreements).toEqual([]);
  // The closure really was walked (not an entry that moved).
  expect(seen.size).toBeGreaterThan(1000);
  expect(imports).toBeGreaterThan(5000);
}, 60_000);

let dir: string;

beforeEach(async () => {
  // Real, as the walk's entries are (tmpdir is a symlink on macOS).
  dir = await realpath(await mkdtemp(join(tmpdir(), "source-digest-resolve-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tree(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
}

test("picks among extensions in the runtime's order, as Bun.resolveSync does", async () => {
  await tree({ "a.ts": "", "x.ts": "", "x.tsx": "", "x.js": "", "x.json": "" });
  const ours = await createImportResolver().resolve("./x", join(dir, "a.ts"));
  expect(ours).toEqual({ kind: "file", path: Bun.resolveSync("./x", dir) });
});

test("refuses a .js specifier two TypeScript twins answer, rather than guess", async () => {
  await tree({ "a.ts": "", "x.ts": "", "x.tsx": "" });
  expect(
    createImportResolver().resolve("./x.js", join(dir, "a.ts")),
  ).rejects.toThrow(UnresolvedImportError);
});

test("refuses a directory whose package.json names an entry", async () => {
  await tree({
    "a.ts": "",
    "pkg/package.json": `{ "main": "lib.js" }`,
    "pkg/index.ts": "",
  });
  expect(
    createImportResolver().resolve("./pkg", join(dir, "a.ts")),
  ).rejects.toThrow(UnresolvedImportError);
});

test("a file added after one walk is seen by the next walk's resolver", async () => {
  await tree({ "a.ts": "", "x/index.ts": "" });
  const importer = join(dir, "a.ts");
  const first = await createImportResolver().resolve("./x", importer);
  await tree({ "x.ts": "" });
  const second = await createImportResolver().resolve("./x", importer);
  expect(first).toMatchObject({
    kind: "file",
    path: expect.stringContaining(`x${sep}index.ts`),
  });
  expect(second).toMatchObject({
    kind: "file",
    path: expect.stringMatching(/x\.ts$/),
  });
});
