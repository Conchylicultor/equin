// The `sql-writes` schema question: the database the code declares, read off
// the declarations themselves, asked of each schema file in the schema
// question host (`askSchemaFiles`, which loads them the way drizzle-kit does).
// For one file it reports:
//   - every drizzle `PgTable` it exports — its columns, each one's physical
//     name, whether an INSERT must name it (NOT NULL with no DB default, not
//     generated, not identity / serial) and whether no write may name it (a
//     generated column, or a derived `updated_at` registered by `defineEntity` /
//     `deriveUpdatedAt` while the files loaded);
//   - what each export reference the check asked about in that file (its
//     input) evaluates to (a table, a column, a string), so
//     `${sdkAgentStops.table}` in a hand-written statement names the table it
//     renders.
// The imperatively created public tables are not the probe's: the check reads
// `IMPERATIVE_PUBLIC_TABLES` itself (`run-probe.ts`).
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { SchemaQuestion } from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import type {
  FileRef,
  ProbeColumn,
  ProbeFileAnswer,
  ProbeTable,
  ResolvedRef,
} from "./probe-types";

type DrizzleColumn = PgColumn & {
  readonly generated?: unknown;
  readonly generatedIdentity?: unknown;
  readonly default?: unknown;
};

// A column INSERT may omit only when the database fills it: a DB default (not a
// JS `$defaultFn`, which a hand-written INSERT never runs), a generated or
// identity column, a serial.
function columnOf(
  col: DrizzleColumn,
  derived: string | undefined,
): ProbeColumn {
  const filled =
    col.default !== undefined ||
    col.generated !== undefined ||
    col.generatedIdentity !== undefined ||
    /Serial/.test(col.columnType);
  return {
    name: col.name,
    required: col.notNull && !filled,
    unwritten:
      col.generated !== undefined
        ? "generated"
        : derived === col.name
          ? "derived-updated-at"
          : null,
  };
}

function schemaOf(table: PgTable): string {
  return getTableConfig(table).schema ?? "public";
}

function resolve(value: unknown): ResolvedRef {
  if (is(value, PgTable))
    return {
      kind: "table",
      schema: schemaOf(value),
      name: getTableName(value),
    };
  if (is(value, PgColumn)) {
    const table = (value as PgColumn).table as PgTable;
    return {
      kind: "column",
      schema: schemaOf(table),
      table: getTableName(table),
      name: (value as PgColumn).name,
    };
  }
  if (typeof value === "string") return { kind: "string", value };
  return { kind: "other", what: value === null ? "null" : typeof value };
}

export default {
  answer(file, exports, refs) {
    // Read after every file loaded (the host asks then): registration happens
    // at module eval.
    const derivedByTable = new Map(
      registeredDerivedUpdatedAt().map((s) => [s.table, s.column]),
    );
    const tables = new Map<string, ProbeTable>();
    for (const value of Object.values(exports)) {
      if (!is(value, PgTable)) continue;
      const name = getTableName(value);
      const schema = schemaOf(value);
      const key = `${schema}.${name}`;
      if (tables.has(key)) continue;
      const derived =
        schema === "public" ? derivedByTable.get(name) : undefined;
      tables.set(key, {
        schema,
        name,
        file,
        columns: Object.values(getTableColumns(value)).map((c) =>
          columnOf(c as DrizzleColumn, derived),
        ),
      });
    }
    const resolved: Record<string, ResolvedRef> = {};
    for (const ref of refs) {
      let value: unknown = exports[ref.exportName];
      for (const key of ref.path) {
        value =
          value !== null && typeof value === "object"
            ? (value as Record<string, unknown>)[key]
            : undefined;
      }
      resolved[ref.id] = resolve(value);
    }
    return { tables: [...tables.values()], refs: resolved };
  },
} satisfies SchemaQuestion<ProbeFileAnswer, readonly FileRef[]>;
