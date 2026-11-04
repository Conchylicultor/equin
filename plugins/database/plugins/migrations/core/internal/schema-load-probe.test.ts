import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { probeSchema, schemaLoadFailures } from "./schema-load-probe";
import { MIGRATIONS_PLUGIN_DIR } from "./schema-glob-patterns";

// A throwaway repo root holding two schema-glob files and this plugin's real
// probe script, so the probe answers about exactly these files. The property
// under test is "ANY load error is a failure": drizzle-kit drops a file that
// throws whatever the error, so the probe must not depend on an error's kind.
// The plain `Error` below is the kind the CLI's old output grep missed (a
// barrel asking for a runtime namespace at module eval).
const root = mkdtempSync(join(tmpdir(), "schema-load-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function schemaFile(plugin: string, body: string): string {
  const dir = join(root, "plugins", plugin, "server", "internal");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tables.ts");
  writeFileSync(file, body);
  return file;
}

const pluginDir = join(root, MIGRATIONS_PLUGIN_DIR);
mkdirSync(pluginDir, { recursive: true });
symlinkSync(
  resolve(import.meta.dir, "../../scripts"),
  join(pluginDir, "scripts"),
);

describe("schemaLoadFailures", () => {
  test("names a file that throws a plain Error at load, and only that file", async () => {
    schemaFile("ok", "export const ok = 1;\n");
    const broken = schemaFile(
      "broken",
      'throw new Error("this process has not declared a runtime namespace");\n',
    );

    const failures = await schemaLoadFailures(root);

    expect(failures.map((f) => f.file)).toEqual([broken]);
    expect(failures[0]!.error).toContain("runtime namespace");
  });
});

describe("probeSchema --tip", () => {
  // A throwaway tree of its own: one table, the real config beside the real
  // probe, and a tip written from drizzle-kit's own snapshot of that table.
  const tree = mkdtempSync(join(tmpdir(), "schema-probe-tip-"));
  afterAll(() => rmSync(tree, { recursive: true, force: true }));
  const dir = join(tree, MIGRATIONS_PLUGIN_DIR);
  mkdirSync(dir, { recursive: true });
  for (const sub of ["scripts", "core"])
    symlinkSync(resolve(import.meta.dir, "../..", sub), join(dir, sub));
  const tableDir = join(tree, "plugins", "probe", "server", "internal");
  mkdirSync(tableDir, { recursive: true });
  writeFileSync(
    join(tableDir, "tables.ts"),
    `import { pgTable, text } from "drizzle-orm/pg-core";\n` +
      `export const probeRows = pgTable("probe_rows", { id: text("id").primaryKey(), note: text("note") });\n`,
  );
  // The table resolves drizzle-orm from the repo's deps (the probe resolves
  // drizzle-kit from its own real path, the migrations plugin's).
  symlinkSync(
    resolve(import.meta.dir, "../../../../../../node_modules"),
    join(tree, "node_modules"),
  );

  async function tipOf(mutate: (t: Record<string, unknown>) => void) {
    const { generateDrizzleJson } = (await import("drizzle-kit/api")) as {
      generateDrizzleJson(i: Record<string, unknown>): Record<string, unknown>;
    };
    const tables = await import(join(tableDir, "tables.ts"));
    const snap = generateDrizzleJson({ ...tables });
    mutate(snap);
    const path = join(tree, `tip-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(snap, null, 2));
    return path;
  }

  test("true when the schema is the tip, ids and key order aside", async () => {
    const tip = await tipOf((s) => {
      s.id = "another";
      s.prevId = "another-parent";
    });
    const probe = await probeSchema(tree, { tip });
    expect(probe).toEqual({ failures: [], matchesTip: true });
  });

  test("false when the tip lacks a column the schema declares", async () => {
    const tip = await tipOf((s) => {
      const t = (
        s.tables as Record<string, { columns: Record<string, unknown> }>
      )["public.probe_rows"]!;
      delete t.columns.note;
    });
    expect((await probeSchema(tree, { tip })).matchesTip).toBe(false);
  });

  test("null when not asked", async () => {
    expect((await probeSchema(tree)).matchesTip).toBeNull();
  });
});
