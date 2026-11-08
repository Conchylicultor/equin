import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ts from "typescript";
import { SiteScanner } from "./sites";

// The scanner over real files in a scratch dir: hole resolution follows imports
// with the TypeScript resolver, which reads the disk.
const root = mkdtempSync(join(tmpdir(), "sql-writes-sites-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

writeFileSync(
  join(root, "tables.ts"),
  `export const things = defineExtension(parent, "thing", shape);\n` +
    `export const THING_TABLE = "things_raw";\n`,
);
writeFileSync(
  join(root, "barrel.ts"),
  `export { things, THING_TABLE as RAW } from "./tables";\n`,
);

const scanner = new SiteScanner(
  root,
  {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
  (abs) => readFileSync(abs, "utf8"),
  new Set([join(root, "tables.ts")]),
);

async function holesOf(src: string) {
  const { sites } = await scanner.scan("use.ts", src);
  return sites.map((s) => s.holes);
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
          file: join(root, "tables.ts"),
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

  test("prose is no site; a sql tag in a plain template's hole is found", async () => {
    const { sites } = await scanner.scan(
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
    const { sites, markers } = await scanner.scan("use.ts", src);
    expect(sites.map((s) => s.marker === null)).toEqual([false, true]);
    expect(markers.length).toBe(1);
    expect(sites[0]?.marker).toBe(markers[0]);
  });

  test("SQL text inside a literal is never a marker comment", async () => {
    const { markers } = await scanner.scan(
      "use.ts",
      "const s = sql`-- sql-writes:hand-written\nDELETE FROM x WHERE id = 1`;\n",
    );
    expect(markers).toEqual([]);
  });

  test("a marker binding no write is still listed, so a stale one can be found", async () => {
    const { sites, markers } = await scanner.scan(
      "use.ts",
      "// sql-writes:hand-written — gone\nconst a = 1;\n",
    );
    expect(sites).toEqual([]);
    expect(markers.length).toBe(1);
  });

  test("one marker above a switch reaches every case's write — which the scan refuses as shared", async () => {
    const { sites } = await scanner.scan(
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
