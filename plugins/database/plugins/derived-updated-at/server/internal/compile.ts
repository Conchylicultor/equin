import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import type { DerivedUpdatedAtSpec, TouchRule } from "./types";

// ── Derived `updatedAt`: the compiler and the registry ─────────────────────
//
// An entity whose `meta.updatedAt` declares `touchedBy` gets its `updated_at`
// maintained by the DATABASE, from that declaration, rather than stamped by
// hand at every write site (where a new write can forget it, and a no-op or a
// view-only write moves it). The declaration compiles into a BEFORE UPDATE row
// trigger that:
//   - RAISEs when a write changes `updated_at` itself — for drizzle and raw SQL
//     alike (rewriting a row with its own value is not a change and passes);
//   - sets it to `now()` iff one of the counted columns really changed
//     (`IS DISTINCT FROM`, so a no-op write never bumps).
// INSERT is untouched: the column keeps its `defaultNow()`.
//
// The declaration is `defineEntity`'s `meta.updatedAt` (infra/entities) or, for
// a raw drizzle table, `deriveUpdatedAt` (`from-table.ts`); both compile through
// `compileFromTable` and register here. Installation (boot, after migrations)
// is `install.ts`, called by the database plugin.
// Plan: research/2026-09-25-global-derived-updated-at.md.

/** One column of the table, as the compiler sees it. */
export interface DerivedUpdatedAtColumn {
  /** JS property key — only used in error messages. */
  readonly key: string;
  /** Physical DB column name. */
  readonly name: string;
  /** The column's SQL type, e.g. `text`, `jsonb` (drizzle's `getSQLType()`). */
  readonly sqlType: string;
  readonly rule: TouchRule<unknown>;
}

export interface DerivedUpdatedAtInput {
  /** Physical table name. */
  readonly table: string;
  /** Physical name of the derived column (normally `updated_at`). */
  readonly updatedAtColumn: string;
  /** Every other column, each with its rule. */
  readonly columns: readonly DerivedUpdatedAtColumn[];
}

// Postgres truncates identifiers to 63 bytes. A truncated trigger name would
// never match the one we look up by, so an install would re-run (and fail its
// own post-install assert) on every boot — refuse it up front instead.
const MAX_IDENT_BYTES = 63;
const SUFFIX = "_derive_updated_at";
const BODY_TAG = "$derive_updated_at$";

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A string as a SQL literal — `pg`'s `escapeLiteral`, character for character
 * (`compile.test.ts` holds it to that), in plain JS so this compiler runs on
 * every host: quotes doubled, and a value holding a backslash spelled as an
 * `E'…'` escape string with its backslashes doubled. The trigger signatures
 * stored in the DB are built from its output, so it must not drift from pg's.
 */
export function escapeLiteral(value: string): string {
  let hasBackslash = false;
  let escaped = "'";
  for (const c of value) {
    if (c === "'") escaped += "''";
    else if (c === "\\") {
      escaped += "\\\\";
      hasBackslash = true;
    } else escaped += c;
  }
  escaped += "'";
  return hasBackslash ? ` E${escaped}` : escaped;
}

// A transition value, as a SQL literal Postgres coerces to the column's type
// (an untyped `'…'` literal compared against a text / int / bool column takes
// that column's type). Only primitives have one obvious stored encoding; a
// jsonb column stores even a string as `"…"`, so a rule on one is refused.
function valueLiteral(
  table: string,
  col: DerivedUpdatedAtColumn,
  v: unknown,
): string {
  if (/^jsonb?$/i.test(col.sqlType)) {
    throw new Error(
      `derived updatedAt on "${table}": column "${col.key}" is ${col.sqlType}; ` +
        `an into/outOf transition rule is only supported on scalar columns ` +
        `(use true / false).`,
    );
  }
  if (typeof v === "string") return escapeLiteral(v);
  if (typeof v === "boolean") return v ? "'true'" : "'false'";
  if (typeof v === "number" && Number.isFinite(v)) {
    return escapeLiteral(String(v));
  }
  throw new Error(
    `derived updatedAt on "${table}": column "${col.key}" has a transition ` +
      `value ${String(v)} (${typeof v}) with no scalar SQL encoding — only ` +
      `strings, finite numbers, booleans and null are supported.`,
  );
}

// `<side>.c` is one of `values` — `null` spelled `IS NULL`, since `IN (NULL)`
// is never true.
function memberOf(
  table: string,
  col: DerivedUpdatedAtColumn,
  side: "NEW" | "OLD",
  values: readonly unknown[],
): string {
  const ref = `${side}.${quoteIdent(col.name)}`;
  const parts: string[] = [];
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length > 0) {
    const lits = [...new Set(nonNull.map((v) => valueLiteral(table, col, v)))];
    parts.push(`${ref} IN (${lits.join(", ")})`);
  }
  if (nonNull.length !== values.length) parts.push(`${ref} IS NULL`);
  return parts.join(" OR ");
}

function columnCondition(
  table: string,
  col: DerivedUpdatedAtColumn,
): string | null {
  const { rule } = col;
  if (rule === false) return null;
  const c = quoteIdent(col.name);
  const changed = `NEW.${c} IS DISTINCT FROM OLD.${c}`;
  if (rule === true) return changed;
  if ("exceptKeys" in rule)
    return exceptKeysCondition(table, col, rule.exceptKeys);
  const into = rule.into ?? [];
  const outOf = rule.outOf ?? [];
  if (into.length === 0 && outOf.length === 0) {
    throw new Error(
      `derived updatedAt on "${table}": column "${col.key}" has a transition ` +
        `rule with neither into nor outOf values — it would never count; ` +
        `declare it false instead.`,
    );
  }
  const transitions = [
    ...(into.length > 0 ? [memberOf(table, col, "NEW", into)] : []),
    ...(outOf.length > 0 ? [memberOf(table, col, "OLD", outOf)] : []),
  ];
  return `(${changed} AND (${transitions.join(" OR ")}))`;
}

// A jsonb object column that counts every change but one to the listed
// top-level keys: both sides with those keys removed (`jsonb - text[]`, which
// drops keys from an object; a non-object value raises in Postgres — loud, not
// silently counted), compared as a whole.
function exceptKeysCondition(
  table: string,
  col: DerivedUpdatedAtColumn,
  keys: readonly string[],
): string {
  if (!/^jsonb$/i.test(col.sqlType)) {
    throw new Error(
      `derived updatedAt on "${table}": column "${col.key}" is ${col.sqlType}; ` +
        `an exceptKeys rule is only supported on jsonb columns.`,
    );
  }
  if (keys.length === 0) {
    throw new Error(
      `derived updatedAt on "${table}": column "${col.key}" has an exceptKeys ` +
        `rule with no keys — declare it true instead.`,
    );
  }
  const c = quoteIdent(col.name);
  const arr = `ARRAY[${[...new Set(keys)].map((k) => escapeLiteral(k)).join(", ")}]::text[]`;
  return `(NEW.${c} - ${arr}) IS DISTINCT FROM (OLD.${c} - ${arr})`;
}

/**
 * Compile a table's `touchedBy` declaration into its trigger function + trigger
 * DDL and the signature that identifies them. Pure: no database access.
 */
export function compileDerivedUpdatedAt(
  input: DerivedUpdatedAtInput,
): DerivedUpdatedAtSpec {
  const { table, updatedAtColumn, columns } = input;
  const triggerName = `${table}${SUFFIX}`;
  if (Buffer.byteLength(triggerName) > MAX_IDENT_BYTES) {
    throw new Error(
      `derived updatedAt on "${table}": trigger name "${triggerName}" exceeds ` +
        `Postgres's ${MAX_IDENT_BYTES}-byte identifier limit.`,
    );
  }
  const seen = new Set<string>();
  for (const col of columns) {
    if (col.name === updatedAtColumn || seen.has(col.name)) {
      throw new Error(
        `derived updatedAt on "${table}": column "${col.name}" is listed twice ` +
          `(or is the updatedAt column itself).`,
      );
    }
    seen.add(col.name);
  }

  const u = quoteIdent(updatedAtColumn);
  const conditions = columns
    .map((col) => columnCondition(table, col))
    .filter((c): c is string => c !== null);
  const message = escapeLiteral(
    `${table}.${updatedAtColumn} is derived (declared by its touchedBy); ` +
      `do not write it`,
  );
  // No counted column ⇒ no bump block: the value never moves after insert.
  const bump =
    conditions.length === 0
      ? ""
      : `  IF ${conditions.join("\n     OR ")} THEN\n    NEW.${u} := now();\n  END IF;\n`;
  const body =
    `BEGIN\n` +
    `  IF NEW.${u} IS DISTINCT FROM OLD.${u} THEN\n` +
    `    RAISE EXCEPTION USING MESSAGE = ${message};\n` +
    `  END IF;\n` +
    bump +
    `  RETURN NEW;\n` +
    `END\n`;
  if (body.includes(BODY_TAG)) {
    throw new Error(
      `derived updatedAt on "${table}": a transition value contains the ` +
        `function body's dollar-quote tag ${BODY_TAG}.`,
    );
  }
  const fn = quoteIdent(triggerName);
  const functionDdl =
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS ${BODY_TAG}\n` +
    body +
    BODY_TAG;
  // `CREATE OR REPLACE TRIGGER` (PG 14+): SHARE ROW EXCLUSIVE only, and an
  // atomic swap — never the ACCESS EXCLUSIVE a DROP + CREATE takes.
  const triggerDdl =
    `CREATE OR REPLACE TRIGGER ${fn} BEFORE UPDATE ON ${quoteIdent(table)} ` +
    `FOR EACH ROW EXECUTE FUNCTION ${fn}()`;
  const signature = sha256Hex(`${functionDdl}\n--\n${triggerDdl}`);
  return { table, triggerName, functionDdl, triggerDdl, signature };
}
