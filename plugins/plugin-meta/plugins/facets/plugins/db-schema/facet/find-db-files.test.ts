import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractContext } from "@plugins/plugin-meta/plugins/facets/core";
import facet from "./index";

const dir = mkdtempSync(join(tmpdir(), "db-schema-facet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, src: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), src);
}

put("server/index.ts", "export {};\n");
put("server/internal/tables.ts", 'export const _a = pgTable("a", {});\n');
put("server/internal/views.ts", 'export const _v = pgView("v").as(q);\n');
put("server/internal/other.ts", "// pgTable( in a comment only\n");
// Test code: never documented as schema, though the name or content matches.
put("server/testing/install-derived-schema.ts", "export {};\n");
put("server/internal/__tests__/tables.ts", 'pgTable("t", {});\n');
put("server/internal/schema.test.ts", "export {};\n");

test("lists schema files by name or content, and never test code", () => {
  const data = facet.extract({
    dir,
    relDir: "fixtures/x",
    pluginId: "x",
  } as ExtractContext) as {
    dbFiles: string[];
  };
  expect(data.dbFiles).toEqual([
    "fixtures/x/server/internal/tables.ts",
    "fixtures/x/server/internal/views.ts",
  ]);
});
