import { getTableName } from "drizzle-orm";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/** A mirrored table, as the triggers and the readers need it. */
export interface MirroredTable {
  /** The table's database name (in `public`). */
  name: string;
  /** Its primary-key columns in key order: database name and whether text-like (keyset order uses `COLLATE "C"` on those). */
  pk: readonly { name: string; collatable: boolean }[];
  /** Every column that leaves the source (database names, omitted ones removed), sorted. */
  columns: readonly string[];
  /** Columns that never leave the source. */
  omit: readonly string[];
}

/** A set of tables mirrored together: one cursor, one reconciliation, one replica schema. */
export interface MirrorSetDefinition {
  id: string;
  tables: readonly MirroredTable[];
}

export interface MirrorSetSpec {
  /** `[a-z0-9_]`, unique: names the set on the wire and in the log. */
  id: string;
  /** The drizzle tables, in `public`, each with a primary key. */
  tables: readonly PgTable[];
  /**
   * Columns that never leave the source (a salted IP hash). Each must be
   * nullable or have a default, so a replica's row is valid without it.
   */
  omit?: readonly PgColumn[];
}

const SET_ID_RE = /^[a-z0-9_]+$/;
/** Postgres truncates identifiers past 63 bytes; the generated function and trigger names must fit. */
const MAX_TABLE_NAME = 63 - "tm_log_".length;
/** Names the generated SQL spells unquoted. */
const PLAIN_IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const COLLATABLE_TYPE_RE =
  /^(text|varchar|character varying|char|character|citext)\b/;

// Module-eval guards: whichever of `defineMirrorSet` / `NeverMirrored` runs
// second throws. The boot check (`assertMirrorSetsAllowed`) re-checks every
// contributed pair, so module import order cannot hide a conflict.
const neverMirroredTables = new WeakMap<PgTable, string>();
const mirroredTables = new WeakMap<PgTable, string>();
const definedSetIds = new Set<string>();

function mirroredTable(
  setId: string,
  table: PgTable,
  omit: readonly PgColumn[],
): MirroredTable {
  const config = getTableConfig(table);
  const name = config.name;
  if (config.schema !== undefined && config.schema !== "public") {
    throw new Error(
      `defineMirrorSet("${setId}"): "${config.schema}.${name}" is not in public — a replica creates its tables LIKE public.<t>`,
    );
  }
  const unquotable = [name, ...config.columns.map((c) => c.name)].find(
    (n) => !PLAIN_IDENT_RE.test(n),
  );
  if (unquotable !== undefined) {
    throw new Error(
      `defineMirrorSet("${setId}"): "${unquotable}" (in ${name}) is not a plain lower-case identifier — the generated SQL spells names unquoted`,
    );
  }
  if (name.length > MAX_TABLE_NAME) {
    throw new Error(
      `defineMirrorSet("${setId}"): table name "${name}" is longer than ${MAX_TABLE_NAME} characters, so its trigger names would be truncated`,
    );
  }
  // A composite key's columns are resolved by name against the table's own
  // columns: the objects `primaryKey()` holds are not the built columns
  // (`getSQLType()` on one never returns).
  const byName = new Map(config.columns.map((c) => [c.name, c]));
  const pkColumns: PgColumn[] =
    config.primaryKeys.length > 0
      ? config.primaryKeys[0]!.columns.map((c) => byName.get(c.name)!)
      : config.columns.filter((c) => c.primary);
  if (pkColumns.length === 0) {
    throw new Error(
      `defineMirrorSet("${setId}"): "${name}" has no primary key — the log keys every change by it`,
    );
  }
  const own = omit.filter((c) => getTableName(c.table) === name);
  for (const c of own) {
    if (c.notNull && !c.hasDefault) {
      throw new Error(
        `defineMirrorSet("${setId}"): omitted column ${name}.${c.name} is NOT NULL with no default — a replica's row would be invalid without it`,
      );
    }
    if (pkColumns.includes(c)) {
      throw new Error(
        `defineMirrorSet("${setId}"): ${name}.${c.name} is part of the primary key and cannot be omitted`,
      );
    }
  }
  const omitted = new Set(own.map((c) => c.name));
  return {
    name,
    pk: pkColumns.map((c) => ({
      name: c.name,
      collatable: COLLATABLE_TYPE_RE.test(c.getSQLType()),
    })),
    columns: config.columns
      .map((c) => c.name)
      .filter((c) => !omitted.has(c))
      .sort(),
    omit: [...omitted].sort(),
  };
}

/**
 * Declare a set of tables mirrored together. Contribute it with
 * `MirrorSet(set)`: the source installs the change-log triggers on its tables
 * and serves it by id. Throws at module eval on a malformed spec, a table
 * already in another set, or a table declared `NeverMirrored`.
 */
export function defineMirrorSet(spec: MirrorSetSpec): MirrorSetDefinition {
  if (!SET_ID_RE.test(spec.id)) {
    throw new Error(
      `defineMirrorSet: set id "${spec.id}" must match ${SET_ID_RE}`,
    );
  }
  if (definedSetIds.has(spec.id)) {
    throw new Error(`defineMirrorSet: set id "${spec.id}" is defined twice`);
  }
  if (spec.tables.length === 0) {
    throw new Error(
      `defineMirrorSet("${spec.id}"): a set mirrors at least one table`,
    );
  }
  const omit = spec.omit ?? [];
  for (const table of spec.tables) {
    const name = getTableName(table);
    const reason = neverMirroredTables.get(table);
    if (reason !== undefined) {
      throw new Error(
        `defineMirrorSet("${spec.id}"): "${name}" is declared NeverMirrored (${reason})`,
      );
    }
    const other = mirroredTables.get(table);
    if (other !== undefined) {
      throw new Error(
        `defineMirrorSet("${spec.id}"): "${name}" is already mirrored by set "${other}" — a table belongs to one set`,
      );
    }
  }
  for (const c of omit) {
    if (!spec.tables.includes(c.table)) {
      throw new Error(
        `defineMirrorSet("${spec.id}"): omitted column ${getTableName(c.table)}.${c.name} is not a column of a table in the set`,
      );
    }
  }
  const tables = spec.tables.map((t) => mirroredTable(spec.id, t, omit));
  const names = new Set(tables.map((t) => t.name));
  if (names.size !== tables.length) {
    throw new Error(`defineMirrorSet("${spec.id}"): a table is listed twice`);
  }
  for (const table of spec.tables) mirroredTables.set(table, spec.id);
  definedSetIds.add(spec.id);
  return { id: spec.id, tables };
}

/** A mirror set this plugin's source serves: its tables get the change-log triggers. */
export const MirrorSet = defineServerContribution<MirrorSetDefinition>(
  "table-mirror-set",
  { docLabel: (set) => set.id },
);

export interface NeverMirroredSpec {
  tables: readonly PgTable[];
  /** Why these rows must never leave the source. */
  reason: string;
}

/**
 * Tables whose rows must never leave the source (a salt that would make hashed
 * identities reversible). Listing one in a mirror set throws — at module eval
 * when the two meet, and at boot over every contribution.
 */
export const NeverMirrored = defineServerContribution<
  { tables: readonly string[]; reason: string },
  NeverMirroredSpec
>("table-mirror-never", {
  docLabel: (c) => c.tables.join(", "),
  project: (spec) => {
    for (const table of spec.tables) {
      const set = mirroredTables.get(table);
      if (set !== undefined) {
        throw new Error(
          `NeverMirrored: "${getTableName(table)}" is already in mirror set "${set}"`,
        );
      }
      neverMirroredTables.set(table, spec.reason);
    }
    return { tables: spec.tables.map(getTableName), reason: spec.reason };
  },
});

/**
 * The boot-time guard over every contribution: no never-mirrored table in a
 * set, no table in two sets, no set id twice.
 */
export function assertMirrorSetsAllowed(
  sets: readonly MirrorSetDefinition[],
  never: readonly { tables: readonly string[]; reason: string }[],
): void {
  const forbidden = new Map<string, string>();
  for (const n of never) for (const t of n.tables) forbidden.set(t, n.reason);
  const owner = new Map<string, string>();
  const ids = new Set<string>();
  for (const set of sets) {
    if (ids.has(set.id)) {
      throw new Error(`table-mirror: set "${set.id}" is contributed twice`);
    }
    ids.add(set.id);
    for (const t of set.tables) {
      const reason = forbidden.get(t.name);
      if (reason !== undefined) {
        throw new Error(
          `table-mirror: set "${set.id}" lists "${t.name}", which is declared NeverMirrored (${reason})`,
        );
      }
      const other = owner.get(t.name);
      if (other !== undefined) {
        throw new Error(
          `table-mirror: "${t.name}" is in sets "${other}" and "${set.id}" — a table belongs to one set`,
        );
      }
      owner.set(t.name, set.id);
    }
  }
}
