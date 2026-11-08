import { getTableName } from "drizzle-orm";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { assertImperativePublicTable } from "@plugins/database/plugins/derived-views/core";
import { ROLLUP } from "./types";
import type {
  CompiledRollupSource,
  Rollup,
  RollupClosure,
  RollupColumn,
  RollupOp,
  RollupSourceSpec,
  RollupSpec,
  RollupTrigger,
} from "./types";

const ALL_OPS: readonly RollupOp[] = ["insert", "update", "delete"];
const OP_SUFFIX: Record<RollupOp, string> = {
  insert: "i",
  update: "u",
  delete: "d",
};
// Postgres truncates identifiers past NAMEDATALEN-1; a truncated generated name
// could collide with another and would never match what the catalog reports.
const MAX_IDENT = 63;
// plpgsql variables, prefixed so they can never shadow a column a rollup's
// `select` names (plpgsql's default variable_conflict = error would refuse it).
const CARRIED = "_rollup_carried";
const KEYS = "_rollup_keys";
const KEY = "_rollup_key";
const LOCK_ONLY = "_rollup_lock_only";
const NEXT = "_rollup_next";
const SEEN = "_rollup_seen";

/** `"name"`, quoted as an identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function qualified(table: string): string {
  return `"public".${quoteIdent(table)}`;
}

function fail(rollup: string, message: string): never {
  throw new Error(`defineRollup("${rollup}"): ${message}`);
}

function tableOf(col: PgColumn): string {
  return getTableName(col.table);
}

// A column of `table`, by name — the eval-time proof that a declared column
// belongs to the table it is used against (a drizzle column carries its table).
function columnOf(
  rollup: string,
  role: string,
  col: PgColumn,
  table: PgTable,
): string {
  const want = getTableName(table);
  if (tableOf(col) !== want) {
    fail(
      rollup,
      `${role} is column "${col.name}" of "${tableOf(col)}", not of "${want}"`,
    );
  }
  return col.name;
}

function primaryKeyOf(rollup: string, table: PgTable): string[] {
  const config = getTableConfig(table);
  const inline = config.columns.filter((c) => c.primary).map((c) => c.name);
  const composite = config.primaryKeys.flatMap((pk) =>
    pk.columns.map((c) => c.name),
  );
  const pk = [...inline, ...composite];
  if (pk.length === 0) {
    fail(rollup, `source "${config.name}" declares no primary key`);
  }
  return pk;
}

function checkIdent(rollup: string, name: string): string {
  if (name.length > MAX_IDENT) {
    fail(rollup, `generated identifier "${name}" exceeds ${MAX_IDENT} bytes`);
  }
  return name;
}

// `ROW(a, b) IS DISTINCT FROM ROW(c, d)` over equal-length column lists;
// `false` when there is nothing to compare (a rollup with no value column).
function distinct(left: readonly string[], right: readonly string[]): string {
  if (left.length === 0) return "false";
  return `ROW(${left.join(", ")}) IS DISTINCT FROM ROW(${right.join(", ")})`;
}

interface Shape {
  table: string;
  key: string;
  keyType: string;
  columns: readonly RollupColumn[];
  values: readonly string[];
  select: RollupSpec["select"];
  closure: { table: string; child: string; parent: string } | undefined;
}

// The `select`, rendered with `scope` — called exactly once.
function renderSelect(s: Shape, scope: (keyExpr: string) => string): string {
  let scoped = 0;
  const rendered = s.select((keyExpr) => {
    scoped += 1;
    if (keyExpr.trim() === "") {
      fail(s.table, "select's scope was called with an empty key expression");
    }
    return scope(keyExpr);
  });
  if (scoped === 0) {
    fail(s.table, "select must call scope (it never did)");
  }
  if (rendered.includes("$rollup$")) {
    fail(s.table, "select must not contain the $rollup$ dollar-quote tag");
  }
  return rendered;
}

// The rows the rollup should hold for the keys in `keysSql` (an array
// expression), or for every key when it is `null`, projected to the table's
// columns by name. That the select returns exactly those columns is asserted
// at install (`selectCheckSql`).
function aggregateCte(s: Shape, keysSql: string | null): string {
  const rendered = renderSelect(s, (keyExpr) =>
    keysSql === null ? "true" : `(${keyExpr}) = ANY(${keysSql})`,
  );
  const cols = s.columns.map((c) => `r.${quoteIdent(c.name)}`).join(", ");
  return `SELECT ${cols} FROM (${rendered}) AS r`;
}

// The A34 lock key of one rollup key, from its text form — the ONE spelling
// both the maintain functions and the reconcile lock by.
function lockKey(rollup: string, keyText: string): string {
  return `hashtextextended(${quoteLiteral(`${rollup}:`)} || ${keyText}, 0)`;
}

// The write half shared by a maintain function and the reconcile: re-aggregate
// the keys in `keysSql`, upsert only a row that changed (an unchanged row keeps
// its xmin), delete a key the aggregate no longer has. Two CTEs and the DELETE
// (without a terminator), for the caller to wrap.
function writeKeys(s: Shape, keysSql: string): { ctes: string; del: string } {
  const cols = s.columns.map((c) => quoteIdent(c.name));
  const qk = quoteIdent(s.key);
  const values = s.values.map(quoteIdent);
  const onConflict =
    values.length === 0
      ? `ON CONFLICT (${qk}) DO NOTHING`
      : `ON CONFLICT (${qk}) DO UPDATE SET ${values.map((v) => `${v} = EXCLUDED.${v}`).join(", ")}
      WHERE ${distinct(
        values.map((v) => `t.${v}`),
        values.map((v) => `EXCLUDED.${v}`),
      )}`;
  return {
    ctes: `_rollup_agg AS (
    ${aggregateCte(s, keysSql)}
  ), _rollup_upserted AS (
    INSERT INTO ${qualified(s.table)} AS t (${cols.join(", ")})
    SELECT ${cols.join(", ")} FROM _rollup_agg
    ${onConflict}
    RETURNING 1
  )`,
    // sql-writes:hand-written — generated from the rollup's declaration
    del: `DELETE FROM ${qualified(s.table)} AS t
   WHERE t.${qk} = ANY(${keysSql})
     AND NOT EXISTS (SELECT 1 FROM _rollup_agg AS a WHERE a.${qk} = t.${qk})`,
  };
}

// A34: one transaction-scoped advisory lock per key, in sorted order.
function lockKeys(rollup: string): string {
  return `FOREACH ${KEY} IN ARRAY ${KEYS} LOOP
    PERFORM pg_advisory_xact_lock(${lockKey(rollup, `${KEY}::text`)});
  END LOOP;`;
}

// A closure rollup's keys: the resolved ones plus every transitive dependent
// (walking the edges from `parent` back to `child`).
//
// Walk, lock the whole set in sorted order, then walk again: the second walk
// is a fresh statement after the locks, so a writer that held one of them (an
// edge insert locks its parent, a facts write its own key) has committed and
// its edge is seen. In the steady state the second walk finds nothing new and
// the locks were taken once, sorted — like any rollup's. Only when an edge
// appeared between the two walks does the loop lock the grown set again, out
// of the first pass's order; two writers racing on one edge can then abort
// with a loud 40P01 — never a stale row.
function expandAndLock(
  rollup: string,
  closure: { table: string; child: string; parent: string },
  keyType: string,
  lockOnly: boolean,
): string {
  const edges = qualified(closure.table);
  const child = quoteIdent(closure.child);
  const parent = quoteIdent(closure.parent);
  const walk = (into: string): string => `WITH RECURSIVE _rollup_d(n) AS (
      SELECT x FROM unnest(${KEYS}) AS u(x)
      UNION
      SELECT e.${child} FROM ${edges} AS e JOIN _rollup_d AS d ON e.${parent} = d.n WHERE e.${child} IS NOT NULL
    )
    SELECT array_agg(d.n ORDER BY d.n) INTO ${into} FROM _rollup_d AS d;`;
  const toLock = lockOnly
    ? `ARRAY(SELECT DISTINCT x FROM unnest(${NEXT} || COALESCE(${LOCK_ONLY}, ARRAY[]::${keyType}[])) AS u(x) ORDER BY x)`
    : NEXT;
  return `${walk(NEXT)}
  LOOP
    FOREACH ${KEY} IN ARRAY ${toLock} LOOP
      PERFORM pg_advisory_xact_lock(${lockKey(rollup, `${KEY}::text`)});
    END LOOP;
    ${walk(SEEN)}
    EXIT WHEN ${SEEN} <@ ${NEXT};
    ${NEXT} := ARRAY(SELECT DISTINCT x FROM unnest(${NEXT} || ${SEEN}) AS u(x) ORDER BY x);
  END LOOP;
  ${KEYS} := ${NEXT};`;
}

function compileSource(
  shape: Shape,
  spec: RollupSourceSpec,
): CompiledRollupSource {
  const rollup = shape.table;
  const table = getTableName(spec.table);
  const pk = primaryKeyOf(rollup, spec.table);
  const carry = columnOf(rollup, "carry", spec.carry, spec.table);
  const reads = spec.reads.map((c, i) =>
    columnOf(rollup, `reads[${i}]`, c, spec.table),
  );
  const ops = spec.ops ?? ALL_OPS;
  if (ops.length === 0) fail(rollup, `source "${table}" fires on no op`);
  if (new Set(ops).size !== ops.length) {
    fail(rollup, `source "${table}" lists an op twice`);
  }

  let via: CompiledRollupSource["via"];
  const carryType = spec.carry.getSQLType();
  if (spec.via !== undefined) {
    const vt = getTableName(spec.via.table);
    const match = columnOf(rollup, "via.match", spec.via.match, spec.via.table);
    const vkey = columnOf(rollup, "via.key", spec.via.key, spec.via.table);
    if (spec.via.match.getSQLType() !== carryType) {
      fail(
        rollup,
        `source "${table}": via.match "${vt}.${match}" is ${spec.via.match.getSQLType()}, carry "${carry}" is ${carryType}`,
      );
    }
    if (spec.via.key.getSQLType() !== shape.keyType) {
      fail(
        rollup,
        `source "${table}": via.key "${vt}.${vkey}" is ${spec.via.key.getSQLType()}, the rollup key is ${shape.keyType}`,
      );
    }
    via = { table: vt, match, key: vkey };
  } else if (carryType !== shape.keyType) {
    fail(
      rollup,
      `source "${table}": carry "${carry}" is ${carryType} but the rollup key is ${shape.keyType} (declare a via hop)`,
    );
  }

  const base = checkIdent(rollup, `${rollup}__${table}`);
  const functionName = checkIdent(rollup, `${base}_maintain`);

  // UPDATE: only the rows whose carry or a read column moved — and a row whose
  // primary key changed, which appears unmatched on both sides of the join.
  const watched = [carry, ...reads.filter((r) => r !== carry)];
  const on = pk
    .map((c) => `o.${quoteIdent(c)} = n.${quoteIdent(c)}`)
    .join(" AND ");
  const moved =
    `o.${quoteIdent(pk[0]!)} IS NULL OR n.${quoteIdent(pk[0]!)} IS NULL OR ` +
    distinct(
      watched.map((c) => `o.${quoteIdent(c)}`),
      watched.map((c) => `n.${quoteIdent(c)}`),
    );
  // A closure's edge source also LOCKS the parent each edge names (never
  // re-aggregates it): see the lock loop below.
  const lockOnly =
    shape.closure !== undefined && shape.closure.table === table
      ? shape.closure.parent
      : undefined;
  // The values of `col` the statement touched, into `into` (an UPDATE: only
  // rows whose carry or a read column moved — both sides).
  const collect = (col: string, into: string): string => {
    const qv = quoteIdent(col);
    return `IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT n.${qv}) INTO ${into} FROM new_rows AS n WHERE n.${qv} IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT o.${qv}) INTO ${into} FROM old_rows AS o WHERE o.${qv} IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT m.v) INTO ${into} FROM (
      SELECT o.${qv} AS v FROM old_rows AS o FULL JOIN new_rows AS n ON ${on} WHERE ${moved}
      UNION ALL
      SELECT n.${qv} AS v FROM old_rows AS o FULL JOIN new_rows AS n ON ${on} WHERE ${moved}
    ) AS m WHERE m.v IS NOT NULL;
  ELSE
    RAISE EXCEPTION 'rollup maintain ${functionName}: unexpected TG_OP %', TG_OP;
  END IF;`;
  };

  const resolveKeys =
    via === undefined
      ? `SELECT array_agg(DISTINCT x ORDER BY x) INTO ${KEYS} FROM unnest(${CARRIED}) AS u(x);`
      : `SELECT array_agg(DISTINCT v.${quoteIdent(via.key)} ORDER BY v.${quoteIdent(via.key)}) INTO ${KEYS}
      FROM ${qualified(via.table)} AS v
     WHERE v.${quoteIdent(via.match)} = ANY(${CARRIED}) AND v.${quoteIdent(via.key)} IS NOT NULL;`;

  const write = writeKeys(shape, KEYS);

  const functionDdl = `CREATE OR REPLACE FUNCTION "public".${quoteIdent(functionName)}() RETURNS trigger
LANGUAGE plpgsql AS $rollup$
DECLARE
  ${CARRIED} ${carryType}[];
  ${KEYS} ${shape.keyType}[];
  ${KEY} ${shape.keyType};${
    shape.closure === undefined
      ? ""
      : `
  ${NEXT} ${shape.keyType}[];
  ${SEEN} ${shape.keyType}[];${
    lockOnly === undefined
      ? ""
      : `
  ${LOCK_ONLY} ${shape.keyType}[];`
  }`
  }
BEGIN
  -- Generated by derived-tables' defineRollup: "${rollup}", source "${table}".
  -- The carried values this statement touched (an UPDATE: only rows whose
  -- carry or a read column moved).
  ${collect(carry, CARRIED)}
  IF ${CARRIED} IS NULL THEN RETURN NULL; END IF;${
    lockOnly === undefined
      ? ""
      : `
  ${collect(lockOnly, LOCK_ONLY)}`
  }

  -- The rollup keys, sorted: the lock order below.
  ${resolveKeys}
  IF ${KEYS} IS NULL THEN RETURN NULL; END IF;

  -- A34: one transaction-scoped advisory lock per key, in sorted order, BEFORE
  -- aggregating. A concurrent writer of the same key waits here until this
  -- transaction ends, and its own aggregate — a fresh statement, so a fresh
  -- snapshot — then sees this one's committed rows. Without it, two writers
  -- each aggregate without the other's rows and the later upsert loses one.
  ${shape.closure === undefined ? lockKeys(rollup) : expandAndLock(rollup, shape.closure, shape.keyType, lockOnly !== undefined)}

  -- Re-aggregate the keys; write only a row that changed (an unchanged row
  -- keeps its xmin), delete a key the aggregate no longer has.
  WITH ${write.ctes}
  ${write.del};
  RETURN NULL;
END;
$rollup$`;

  const triggers: RollupTrigger[] = ops.map((op) => {
    const name = checkIdent(rollup, `${base}_${OP_SUFFIX[op]}`);
    const referencing =
      op === "insert"
        ? "REFERENCING NEW TABLE AS new_rows"
        : op === "delete"
          ? "REFERENCING OLD TABLE AS old_rows"
          : "REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows";
    // No column list on UPDATE (C1): Postgres refuses transition tables on a
    // trigger with one. The maintain function filters the moved rows itself.
    return {
      name,
      op,
      ddl: `CREATE OR REPLACE TRIGGER ${quoteIdent(name)} AFTER ${op.toUpperCase()} ON ${qualified(table)}
  ${referencing}
  FOR EACH STATEMENT EXECUTE FUNCTION "public".${quoteIdent(functionName)}()`,
    };
  });

  return {
    table,
    pk,
    carry,
    carryType,
    via,
    reads,
    ops,
    functionName,
    functionDdl,
    triggers,
  };
}

// The reconcile (D21, A34), in three statements the boot layer runs in order,
// inside one transaction:
//
//   1. `driftSql` — read-only: the keys whose row differs from the aggregate,
//      is missing, or has no aggregate. A clean boot stops here, writing
//      nothing and locking nothing.
//   2. `lockSql(keys)` — the maintain functions' per-key advisory lock, in the
//      same (sorted) order, held until the schema layer commits.
//   3. `reconcileSql(keys)` — re-aggregates those keys in a FRESH statement
//      (a fresh snapshot, under READ COMMITTED) and writes only what differs.
//
// The lock is what makes a heal safe against a writer the previous backend
// commits during a hot swap. A maintain holding a key's lock commits before
// step 3 aggregates, so step 3 sees its rows; one arriving after waits for the
// layer to commit and then aggregates over the healed state. Without it, a
// maintain that found the drifted row already equal to its new aggregate would
// write nothing, and the reconcile would then overwrite the row with an
// aggregate from a snapshot predating that write.

function keysArray(s: Shape, keys: readonly string[]): string {
  return `ARRAY(SELECT e.k::${s.keyType} FROM jsonb_array_elements_text(${quoteLiteral(JSON.stringify(keys))}::jsonb) AS e(k))`;
}

function driftSql(s: Shape): string {
  const qk = quoteIdent(s.key);
  const values = s.values.map(quoteIdent);
  const t = qualified(s.table);
  return `WITH _rollup_agg AS (
  ${aggregateCte(s, null)}
), _rollup_drift AS (
  SELECT a.${qk} AS k FROM _rollup_agg AS a JOIN ${t} AS t ON t.${qk} = a.${qk}
   WHERE ${distinct(
     values.map((v) => `t.${v}`),
     values.map((v) => `a.${v}`),
   )}
  UNION
  SELECT a.${qk} FROM _rollup_agg AS a
   WHERE NOT EXISTS (SELECT 1 FROM ${t} AS t WHERE t.${qk} = a.${qk})
  UNION
  SELECT t.${qk} FROM ${t} AS t
   WHERE NOT EXISTS (SELECT 1 FROM _rollup_agg AS a WHERE a.${qk} = t.${qk})
)
SELECT COALESCE(array_agg(d.k::text ORDER BY d.k), ARRAY[]::text[]) AS keys FROM _rollup_drift AS d`;
}

// A volatile function in the target list is evaluated after the sort, so the
// locks are taken in `keys` order.
function lockSql(s: Shape, keys: readonly string[]): string {
  return `SELECT pg_advisory_xact_lock(${lockKey(s.table, "e.k")})
  FROM jsonb_array_elements_text(${quoteLiteral(JSON.stringify(keys))}::jsonb) WITH ORDINALITY AS e(k, i)
 ORDER BY e.i`;
}

function reconcileSql(s: Shape, keys: readonly string[]): string {
  const write = writeKeys(s, keysArray(s, keys));
  return `WITH ${write.ctes}, _rollup_deleted AS (
  ${write.del}
  RETURNING 1
)
SELECT (SELECT count(*) FROM _rollup_upserted)::int AS upserted,
       (SELECT count(*) FROM _rollup_deleted)::int AS deleted`;
}

function compileClosure(
  rollup: string,
  closure: RollupClosure,
  keyType: string,
): { table: string; child: string; parent: string } {
  const child = columnOf(rollup, "closure.child", closure.child, closure.edges);
  const parent = columnOf(
    rollup,
    "closure.parent",
    closure.parent,
    closure.edges,
  );
  if (child === parent) {
    fail(rollup, "closure.child and closure.parent are the same column");
  }
  for (const [role, col] of [
    ["child", closure.child],
    ["parent", closure.parent],
  ] as const) {
    if (col.getSQLType() !== keyType) {
      fail(
        rollup,
        `closure.${role} "${col.name}" is ${col.getSQLType()}, the rollup key is ${keyType} — an edge names two keys`,
      );
    }
  }
  return { table: getTableName(closure.edges), child, parent };
}

/**
 * Declare a trigger-maintained rollup. Everything is generated from the
 * declaration: the table (from the drizzle handle's columns), and per source a
 * maintain function and its `<rollup>__<source>_{i,u,d}` triggers, plus the
 * diff-first reconcile. Contribute the result with `DerivedTable(rollup)`.
 *
 * Asserted here, at module eval (a declaration bug never reaches a boot):
 * the table is an IMPERATIVE_PUBLIC_TABLES value (C11); `key` is the table's
 * single-column primary key; each source's columns belong to it and its carry
 * (or via hop) has the key's type; no two sources share a table.
 */
export function defineRollup<T extends PgTable>(
  spec: RollupSpec<T>,
): Rollup<T> {
  const table = assertImperativePublicTable(getTableName(spec.table));
  const config = getTableConfig(spec.table);
  if (config.primaryKeys.length > 0) {
    fail(
      table,
      "a rollup's primary key is its single `key` column, not a composite",
    );
  }
  const key = columnOf(table, "key", spec.key, spec.table);
  const pk = config.columns.filter((c) => c.primary).map((c) => c.name);
  if (pk.length !== 1 || pk[0] !== key) {
    fail(
      table,
      `key "${key}" must be the table's only primary-key column (found [${pk.join(", ")}])`,
    );
  }
  const columns: RollupColumn[] = [
    ...config.columns.filter((c) => c.name === key),
    ...config.columns.filter((c) => c.name !== key),
  ].map((c) => ({
    name: c.name,
    sqlType: c.getSQLType(),
    notNull: c.notNull || c.primary,
  }));
  if (spec.sources.length === 0) fail(table, "declares no source");
  const keyType = spec.key.getSQLType();

  const shape: Shape = {
    table,
    key,
    keyType,
    columns,
    values: columns.filter((c) => c.name !== key).map((c) => c.name),
    select: spec.select,
    closure:
      spec.closure === undefined
        ? undefined
        : compileClosure(table, spec.closure, keyType),
  };
  const sources = spec.sources.map((s) => compileSource(shape, s));
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.table)) fail(table, `two sources on "${s.table}"`);
    seen.add(s.table);
  }
  if (shape.closure !== undefined) {
    const { table: edges, child } = shape.closure;
    const src = sources.find((s) => s.table === edges);
    if (src === undefined || src.carry !== child || src.via !== undefined) {
      fail(
        table,
        `the closure's edge table "${edges}" must be a source carrying "${child}" with no via — a new or dropped edge moves its child's ancestors, and every key below it`,
      );
    }
  }

  const columnDdl = columns
    .map(
      (c) =>
        `  ${quoteIdent(c.name)} ${c.sqlType}${c.name === key ? " PRIMARY KEY" : c.notNull ? " NOT NULL" : ""}`,
    )
    .join(",\n");
  // The table name is generated from the handle, so this line carries the
  // runtime allowlist assert in place of a constant (the
  // imperative-create-table-allowlisted check reads it as the coupling).
  const createTableDdl = `CREATE TABLE IF NOT EXISTS "public".${quoteIdent(assertImperativePublicTable(table))} (
${columnDdl}
)`;

  return {
    [ROLLUP]: true,
    table,
    handle: spec.table,
    key,
    columns,
    sources,
    fed: spec.fed === true,
    ...(shape.closure === undefined ? {} : { closure: shape.closure }),
    createTableDdl,
    // The scope keeps naming the key expression (so its columns count as
    // read) without filtering anything.
    selectCheckSql: renderSelect(
      shape,
      (keyExpr) => `((${keyExpr}) IS NULL OR true)`,
    ),
    driftSql: driftSql(shape),
    lockSql: (keys) => lockSql(shape, keys),
    reconcileSql: (keys) => reconcileSql(shape, keys),
  };
}
