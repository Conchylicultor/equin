import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  entityRefIdentifiers,
  findProducedWrites,
  findProducerDecls,
  resolveEntityRefNames,
  resolveTableNames,
} from "./producer-writes";

const TABLES = `
import { pgTable, text } from "drizzle-orm/pg-core";
export const _reports = deriveUpdatedAt(pgTable("reports", { id: text("id").primaryKey() }));
`;
const PRODUCER = `
import { defineChangeProducer } from "@plugins/database/plugins/change-feed/server";
import { _reports } from "./tables";
export const reportsProducer = defineChangeProducer({
  table: _reports,
  durability: "volatile",
  reason: "r",
  coalesce: "none",
});
`;

const tablesMap = () => {
  const decls = findProducerDecls(ts, [{ rel: "p.ts", src: PRODUCER }]);
  return resolveTableNames(
    ts,
    [{ rel: "tables.ts", src: TABLES }],
    new Set(decls.map((d) => d.binding)),
  );
};

// A template interpolation spelled in the scanned source (`${name}`).
const interp = (name: string): string => "$" + "{" + name + "}";

// Every scanned writer imports the binding and the producer on line 1, so a
// write's reported line is its index in `lines` + 2.
const IMPORTS = `import { _reports } from "./tables"; import { reportsProducer } from "./producer";`;
const writes = (lines: readonly string[], header = IMPORTS) =>
  findProducedWrites(
    ts,
    [{ rel: "w.ts", src: [header, ...lines].join("\n") }],
    tablesMap(),
    new Set(["reportsProducer"]),
  ).map((w) => [w.kind, w.line]);

describe("producer-writes scan", () => {
  test("finds the producer's binding and resolves it through a wrapper", () => {
    expect(findProducerDecls(ts, [{ rel: "p.ts", src: PRODUCER }])).toEqual([
      {
        binding: "_reports",
        producer: "reportsProducer",
        path: "p.ts",
        line: 4,
      },
    ]);
    expect(tablesMap()).toEqual(new Map([["_reports", new Set(["reports"])]]));
  });

  test("resolves an entity built from a ref through the ref's `entityRef` name", () => {
    const tables = `
const reportsEntity = defineEntity(reportsEntityRef, { primaryKey: "id" });
export const _reports = reportsEntity.table;
export const _direct = defineEntity(otherRef, serverFields, {}).table;
`;
    const refFile = `
export const reportsEntityRef = entityRef("reports", reportFields);
export const otherRef = entityRef("other_rows", fields);
export const unrelatedRef = entityRef("unrelated", fields);
`;
    const bindings = new Set(["_reports", "_direct"]);
    const refs = entityRefIdentifiers(
      ts,
      [{ rel: "server/tables.ts", src: tables }],
      bindings,
    );
    expect(refs).toEqual(new Set(["reportsEntityRef", "otherRef"]));
    const refNames = resolveEntityRefNames(
      ts,
      [{ rel: "core/entity.ts", src: refFile }],
      refs,
    );
    expect(
      resolveTableNames(
        ts,
        [{ rel: "server/tables.ts", src: tables }],
        bindings,
        refNames,
      ),
    ).toEqual(
      new Map([
        ["_reports", new Set(["reports"])],
        ["_direct", new Set(["other_rows"])],
      ]),
    );
  });

  test("resolves an entity's table: `defineEntity(…)` or `<entity>.table`", () => {
    const entityTables = `
const traces = defineEntity(tracesRef, { primaryKey: "id" });
export const _traces = traces.table;
export const _inline = defineEntity(inlineRef).table;
const notAnEntity = { table: 1 };
export const _bogus = notAnEntity.table;
`;
    expect(
      resolveTableNames(
        ts,
        [{ rel: "tables.ts", src: entityTables }],
        new Set(["_traces", "_inline", "_bogus"]),
        new Map([
          ["tracesRef", new Set(["traces"])],
          ["inlineRef", new Set(["inline_rows"])],
        ]),
      ),
    ).toEqual(
      new Map([
        ["_traces", new Set(["traces"])],
        ["_inline", new Set(["inline_rows"])],
      ]),
    );
    // A write beside the entity's own declaration is in scope too.
    expect(
      findProducedWrites(
        ts,
        [
          {
            rel: "tables.ts",
            src: `${entityTables}\nawait db.delete(_traces).where(p);`,
          },
        ],
        new Map([["_traces", new Set(["traces"])]]),
        new Set(["tracesProducer"]),
      ).map((w) => [w.kind, w.line]),
    ).toEqual([["drizzle", 8]]);
  });

  test("flags a drizzle write on the binding outside mutate", () => {
    expect(
      writes([
        "await db.update(_reports).set({ noise: true });",
        "await db.insert(_reports).values(v);",
        "await db.delete(_reports).where(p);",
        "await db.select().from(_reports);",
      ]),
    ).toEqual([
      ["drizzle", 2],
      ["drizzle", 3],
      ["drizzle", 4],
    ]);
  });

  test("follows an aliased import, a re-bind and a property access", () => {
    expect(
      writes(
        [
          "const again = r;",
          "await db.delete(r).where(p);",
          "await db.update(again).set(x);",
          "await db.insert(schema._reports).values(v);",
        ],
        `import { _reports as r } from "./tables";`,
      ),
    ).toEqual([
      ["drizzle", 3],
      ["drizzle", 4],
      ["drizzle", 5],
    ]);
  });

  test("an unrelated local that only shares the name is not the table", () => {
    expect(
      writes(
        ["const _reports = new Set<string>();", "seen.delete(_reports);"],
        "",
      ),
    ).toEqual([]);
  });

  test("the table's own declaring file is in scope", () => {
    expect(
      writes(
        [
          `const _reports = pgTable("reports", {});`,
          "await db.delete(_reports);",
        ],
        "",
      ),
    ).toEqual([["drizzle", 3]]);
  });

  test("a write inside a mutate builder callback is the producer's own", () => {
    expect(
      writes([
        "await reportsProducer.mutate(db, (q, t) => q.update(t).set(x), { latency: 'background' });",
        "await reportsProducer.mutate(db, (q) => q.delete(_reports).where(p), { latency: 'background' });",
        "await reportsProducer.mutate(db, function (q) { return q.insert(_reports).values(v); }, { latency: 'interactive' });",
      ]),
    ).toEqual([]);
  });

  test("only a producer's mutate, and only the builder it returns", () => {
    expect(
      writes([
        "await query.mutate(db, (q) => q.delete(_reports), {});",
        "await reportsProducer.mutate(db, (q) => { void db.delete(_reports); return q.update(_reports).set(x); }, { latency: 'background' });",
      ]),
    ).toEqual([
      ["drizzle", 2],
      ["drizzle", 3],
    ]);
  });

  test("flags raw SQL writing the table, quoted, qualified or interpolated", () => {
    expect(
      writes([
        "await db.execute(sql`DELETE FROM reports`);",
        'await pool.query(\'UPDATE "public"."reports" SET noise = true\');',
        `await db.execute(sql\`WITH x AS (SELECT 1) INSERT INTO reports (id) VALUES (${interp("id")})\`);`,
        `await db.execute(sql\`UPDATE ${interp("_reports")} SET noise = true\`);`,
        "await db.execute(sql`SELECT * FROM reports`);",
        "await db.execute(sql`DELETE FROM reports_archive`);",
        "// DELETE FROM reports in a comment is no write",
        "await db.execute(sql`TRUNCATE TABLE reports`);",
        "await db.execute(sql`MERGE INTO reports USING x ON true WHEN MATCHED THEN DELETE`);",
      ]),
    ).toEqual([
      ["sql", 2],
      ["sql", 3],
      ["sql", 4],
      ["sql", 5],
      ["sql", 9],
      ["sql", 10],
    ]);
  });
});
