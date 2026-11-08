// The `sql-writes` schema probe: the database the code declares, read off the
// declarations themselves. Loads every schema-glob file the way drizzle-kit does
// (a synchronous `require()` each, under `bun --bun`, from the migrations plugin
// dir), and reports:
//   - every drizzle `PgTable` they export — its columns, each one's physical
//     name, whether an INSERT must name it (NOT NULL with no DB default, not
//     generated, not identity / serial) and whether no write may name it (a
//     generated column, or a derived `updated_at` registered by `defineEntity` /
//     `deriveUpdatedAt` while the files loaded);
//   - the imperatively created public tables (`IMPERATIVE_PUBLIC_TABLES`), whose
//     columns the check reads from the hand-written DDL it finds in source;
//   - what each export reference the check asked about evaluates to (a table, a
//     column, a string), so `${sdkAgentStops.table}` in a hand-written statement
//     names the table it renders.
//
// Run as: bun --bun schema-probe.ts, with `ProbeInput` JSON on stdin.
// Emits `ProbeOutput` JSON (`probe-types.ts`).
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgColumn, PgTable } from "drizzle-orm/pg-core";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { IMPERATIVE_PUBLIC_TABLES } from "@plugins/database/plugins/derived-views/core";
import type {
  ProbeColumn,
  ProbeInput,
  ProbeOutput,
  ProbeTable,
  ResolvedRef,
} from "./probe-types";

const input = JSON.parse(await Bun.stdin.text()) as ProbeInput;

const modules = new Map<string, Record<string, unknown>>();
const loadFailures: { file: string; error: string }[] = [];
for (const file of input.files) {
  try {
    modules.set(file, require(file) as Record<string, unknown>);
  } catch (e) {
    loadFailures.push({ file, error: String(e) });
  }
}

// Read AFTER every file loaded: registration happens at module eval.
const derivedByTable = new Map(
  registeredDerivedUpdatedAt().map((s) => [s.table, s.column]),
);

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

const tables = new Map<string, ProbeTable>();
for (const [file, mod] of modules) {
  for (const value of Object.values(mod)) {
    if (!is(value, PgTable)) continue;
    const name = getTableName(value);
    const schema = schemaOf(value);
    const key = `${schema}.${name}`;
    if (tables.has(key)) continue;
    const derived = schema === "public" ? derivedByTable.get(name) : undefined;
    tables.set(key, {
      schema,
      name,
      file,
      columns: Object.values(getTableColumns(value)).map((c) =>
        columnOf(c as DrizzleColumn, derived),
      ),
    });
  }
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

const refs: Record<string, ResolvedRef> = {};
for (const ref of input.refs) {
  const mod = modules.get(ref.file);
  if (!mod) {
    refs[ref.id] = { kind: "other", what: "a module the probe did not load" };
    continue;
  }
  let value: unknown = mod[ref.exportName];
  for (const key of ref.path) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  refs[ref.id] = resolve(value);
}

const output: ProbeOutput = {
  tables: [...tables.values()],
  imperative: Object.values(IMPERATIVE_PUBLIC_TABLES),
  refs,
  loadFailures,
};
process.stdout.write(JSON.stringify(output));
