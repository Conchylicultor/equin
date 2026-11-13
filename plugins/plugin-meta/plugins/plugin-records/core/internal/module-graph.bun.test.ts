import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { repoFilesOver } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildModuleGraph, NO_OUTSIDE_FILES } from "./module-graph";
import { createMemoryRecordStore } from "./store";

// The graph resolves a specifier as Bun does, or a record keyed on its edges
// (closureRecord's `bundled`) could outlive what Bun would load: every
// sibling pair a specifier could name, against a real `Bun.build`.
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const EXTS = [".tsx", ".jsx", ".ts", ".mjs", ".js", ".cjs", ".json"];

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(files: Record<string, string>): string {
  // The bundler reports real paths (macOS's /var is /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "graph-vs-bun-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const body = (ext: string) =>
  ext === ".json"
    ? "{}"
    : ext === ".cjs"
      ? "module.exports = {};"
      : "export {};";

describe("the module graph resolves as Bun.build", () => {
  test("for every pair of sibling extensions, as a file and as a directory index", async () => {
    const files: Record<string, string> = {
      [SCAN_PATH]: readFileSync(
        join(import.meta.dir, "scan-imports.ts"),
        "utf8",
      ),
    };
    const imports: string[] = [];
    for (const [i, a] of EXTS.entries())
      for (const b of EXTS.slice(i + 1)) {
        const n = `${a.slice(1)}_${b.slice(1)}`;
        for (const e of [a, b]) {
          files[`f/${n}${e}`] = body(e);
          files[`d/${n}/index${e}`] = body(e);
        }
        imports.push(`import "./f/${n}";`, `import "./d/${n}";`);
      }
    files["entry.ts"] = imports.join("\n");
    const root = write(files);

    const loaded = new Set<string>();
    const built = await Bun.build({
      entrypoints: [join(root, "entry.ts")],
      target: "bun",
      plugins: [
        {
          name: "record",
          setup(b) {
            b.onLoad({ filter: /.*/ }, (a) => {
              loaded.add(relative(root, a.path));
              return undefined;
            });
          },
        },
      ],
    });
    expect(built.success).toBe(true);

    const repo = repoFilesOver(asAppPath(root), Object.keys(files).sort());
    const graph = await buildModuleGraph(
      {
        snapshot: repo,
        store: createMemoryRecordStore(),
        readOutside: NO_OUTSIDE_FILES,
      },
      ["entry.ts"],
    );
    const closure = graph.bundledClosure(["entry.ts"]);
    expect([...closure.modules].sort()).toEqual([...loaded].sort());
  });

  test("a directory with a package.json is refused, not resolved to its index", async () => {
    const files = {
      [SCAN_PATH]: readFileSync(
        join(import.meta.dir, "scan-imports.ts"),
        "utf8",
      ),
      "entry.ts": 'import "./d";',
      "d/index.ts": "export {};",
      "d/main.ts": "export {};",
      "d/package.json": '{ "main": "main.ts" }',
    };
    const root = write(files);
    const repo = repoFilesOver(asAppPath(root), Object.keys(files).sort());
    expect(
      buildModuleGraph(
        {
          snapshot: repo,
          store: createMemoryRecordStore(),
          readOutside: NO_OUTSIDE_FILES,
        },
        ["entry.ts"],
      ),
    ).rejects.toThrow("has a package.json");
  });
});
