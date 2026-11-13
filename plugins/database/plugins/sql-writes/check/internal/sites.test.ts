import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  createSourceAnalysis,
  readRepoCompilerOptions,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { createHoleResolver } from "./resolve";
import { scanFileSites as scanParsed } from "./sites";

// The per-file scan (what a file's fold records), then the cross-file
// resolution of its deferred holes over an in-memory repo: imports followed
// with the repo project's own module resolution.
const FILES: Record<string, string> = {
  "tsconfig.json": `{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler" } }`,
  "tables.ts":
    `export const things = defineExtension(parent, "thing", shape);\n` +
    `export const THING_TABLE = "things_raw";\n`,
  "barrel.ts": `export { things, THING_TABLE as RAW } from "./tables";\n`,
};
const repo = {
  has: (rel: string) => Object.hasOwn(FILES, rel),
  read: (rel: string) => Promise.resolve(FILES[rel] ?? null),
};
const resolver = createHoleResolver({
  analysis: createSourceAnalysis({
    ts,
    files: repo,
    parse: ({ rel, src }) =>
      Promise.resolve(
        ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true),
      ),
    compilerOptions: await readRepoCompilerOptions(ts, repo),
  }),
  schemaFiles: new Set(["tables.ts"]),
});

const scanFileSites = (rel: string, src: string) =>
  scanParsed(ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true));

async function holesOf(src: string) {
  const { sites } = scanFileSites("use.ts", src);
  const out = [];
  for (const s of sites) out.push((await resolver.resolveSite(s)).holes);
  return out;
}

describe("hole resolution", () => {
  test("an imported schema export, through a barrel's re-export, is evaluated by the probe", async () => {
    const [holes] = await holesOf(
      `import { things } from "./barrel";\n` +
        `const q = sql\`INSERT INTO \${things.table} (a) VALUES (1)\`;\n`,
    );
    expect(holes).toEqual([
      {
        kind: "export",
        ref: {
          file: "tables.ts",
          exportName: "things",
          path: ["table"],
        },
      },
    ]);
  });

  test("a constant string spliced into plain interpolation is text; sql.raw of one too", async () => {
    const [plain, raw] = await holesOf(
      `import { RAW } from "./barrel";\n` +
        `const a = \`DELETE FROM \${RAW} WHERE id = $1\`;\n` +
        "const t = sql.raw(RAW);\n" +
        `const b = sql\`DELETE FROM \${t} WHERE id = 1\`;\n`,
    );
    expect(plain).toEqual([{ kind: "text", text: "things_raw" }]);
    expect(raw).toEqual([{ kind: "text", text: "things_raw" }]);
  });

  test("a parameter, a destructured binding or a local function shadows an import", async () => {
    const sites = await holesOf(
      `import { things } from "./barrel";\n` +
        `function f(things) { return sql\`DELETE FROM \${things.table}\`; }\n` +
        `function g() { const { things } = pick(); return sql\`DELETE FROM \${things.table}\`; }\n` +
        `function h() { function things() {} return sql\`DELETE FROM \${things.table}\`; }\n`,
    );
    expect(sites.map((h) => h[0]?.kind)).toEqual([
      "opaque",
      "opaque",
      "opaque",
    ]);
  });

  test("a template splicing an imported constant, and a namespace import's member, resolve across files", async () => {
    const [tpl, ns] = await holesOf(
      `import { RAW } from "./barrel";\nimport * as T from "./tables";\n` +
        `const name = \`\${RAW}_v2\`;\n` +
        `const a = \`DELETE FROM \${name} WHERE id = $1\`;\n` +
        `const b = sql\`DELETE FROM \${T.things.table} WHERE id = 1\`;\n`,
    );
    expect(tpl).toEqual([{ kind: "text", text: "things_raw_v2" }]);
    expect(ns).toEqual([
      {
        kind: "export",
        ref: {
          file: "tables.ts",
          exportName: "things",
          path: ["table"],
        },
      },
    ]);
  });

  test("a file's own sites are found without reading any other file; the holes another file decides are deferred", () => {
    const { sites } = scanFileSites(
      "use.ts",
      `import { RAW } from "./nowhere";\nconst a = \`DELETE FROM \${RAW} WHERE id = $1\`;\n`,
    );
    expect(sites.map((s) => s.holes.map((h) => h.kind))).toEqual([
      ["deferred"],
    ]);
  });

  test("an import naming no file of the repo is opaque", async () => {
    const [holes] = await holesOf(
      `import { RAW } from "./nowhere";\nconst a = \`DELETE FROM \${RAW} WHERE id = $1\`;\n`,
    );
    expect(holes).toEqual([{ kind: "opaque", expr: "RAW" }]);
  });

  test("prose is no site; a sql tag in a plain template's hole is found", async () => {
    const { sites } = scanFileSites(
      "use.ts",
      'const m = "update the gateway";\n' +
        `const s = \`\${sql\`DELETE FROM x WHERE id = 1\`}\`;\n`,
    );
    expect(sites.map((s) => s.chunks.join("|"))).toEqual([
      "DELETE FROM x WHERE id = 1",
    ]);
  });
});

describe("site markers (sql-writes:hand-written)", () => {
  test("a marker on the statement binds every write in it; an unmarked write is unbound", async () => {
    const src =
      "async function f() {\n" +
      "  // sql-writes:hand-written — a recursive CTE\n" +
      "  await db.execute(sql`DELETE FROM x WHERE id = 1`);\n" +
      "  await db.execute(sql`DELETE FROM y WHERE id = 1`);\n" +
      "}\n";
    const { sites, markers } = scanFileSites("use.ts", src);
    expect(sites.map((s) => s.marker === null)).toEqual([false, true]);
    expect(markers.length).toBe(1);
    expect(sites[0]?.marker).toBe(markers[0]?.pos ?? -1);
  });

  test("SQL text inside a literal is never a marker comment", async () => {
    const { markers } = scanFileSites(
      "use.ts",
      "const s = sql`-- sql-writes:hand-written\nDELETE FROM x WHERE id = 1`;\n",
    );
    expect(markers).toEqual([]);
  });

  test("a marker binding no write is still listed, so a stale one can be found", async () => {
    const { sites, markers } = scanFileSites(
      "use.ts",
      "// sql-writes:hand-written — gone\nconst a = 1;\n",
    );
    expect(sites).toEqual([]);
    expect(markers.length).toBe(1);
  });

  test("one marker above a switch reaches every case's write — which the scan refuses as shared", async () => {
    const { sites } = scanFileSites(
      "use.ts",
      "function f(k) {\n" +
        "  // sql-writes:hand-written — one\n" +
        "  switch (k) {\n" +
        "    case 1: return sql`DELETE FROM x WHERE id = 1`;\n" +
        "    case 2: return sql`DELETE FROM y WHERE id = 1`;\n" +
        "  }\n" +
        "}\n",
    );
    // Both sites resolve to the same comment: scanSqlWrites reports a marker
    // binding more than one write, so a case added later is never covered.
    expect(sites.length).toBe(2);
    expect(sites[0]?.marker).toBe(sites[1]?.marker ?? -1);
  });
});
