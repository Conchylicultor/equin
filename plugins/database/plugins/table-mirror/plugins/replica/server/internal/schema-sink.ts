import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type {
  MirrorKeyedRow,
  MirrorPk,
} from "@plugins/database/plugins/table-mirror/core";
import {
  mirrorSql,
  readTableFingerprints,
  type MirroredTable,
  type MirrorSetDefinition,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import type { Exec, KeyHash, ReplicaTx } from "./exec";

// The default sink: the replica's own Postgres schema, holding one table per
// mirrored table made `LIKE public.<t>` — the local install's own DDL, so the
// owning plugin's SQL runs unchanged against the copy (`withReplicaSchema`).
// Names are plain identifiers (asserted by `defineMirrorSet`, and the schema
// name is minted here), so they are spelled unquoted.

const { lit, textArray, pkJson, pkOrder, typedKey, rowHash } = mirrorSql;

/**
 * A replica's schema name: `tm_<set>_<hash of the replica id>`. 60 characters
 * at most, so the rebuild's scratch schema (`<name>_r`) also fits Postgres's
 * 63-byte identifiers.
 */
export function replicaSchemaName(
  setId: string,
  replicaId: string,
  hash: (s: string) => string,
): string {
  return `tm_${setId.slice(0, 46)}_${hash(replicaId).slice(0, 10)}`;
}

const ColumnRowSchema = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.boolean(),
  hasdef: z.boolean(),
});
type ColumnInfo = z.infer<typeof ColumnRowSchema>;

/** A table's live columns, in column order. */
async function columnsOf(
  exec: Exec,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  return executeRows(exec, {
    query: sql.raw(
      `SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull, a.atthasdef AS hasdef
       FROM pg_attribute a
       WHERE a.attrelid = ${lit(`${schema}.${table}`)}::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
    ),
    row: ColumnRowSchema,
    label: `table-mirror: columns of ${schema}.${table}`,
  });
}

/** The mirror table's columns: what a keys / rows request asks the source to hash. */
export async function mirrorColumns(
  exec: Exec,
  schema: string,
  t: MirroredTable,
): Promise<string[]> {
  return (await columnsOf(exec, schema, t.name)).map((c) => c.name).sort();
}

const IndexRowSchema = z.object({
  def: z.string(),
  index: z.string(),
  constraint: z.string().nullable(),
  exclusion: z.boolean(),
});

/**
 * `CREATE TABLE <schema>.<t> (LIKE public.<t> …)`, minus the omitted columns.
 * LIKE copies no foreign keys (a cascade arrives as tombstones, never as a
 * local cascade) and no triggers. Unique and exclusion constraints are
 * relaxed to plain indexes: a copy passes through states the source never
 * had (a reconcile page applies one key range while a value it moved is
 * still held by a row of a later range), and uniqueness is the source's to
 * keep, not the copy's.
 */
async function createLike(
  tx: ReplicaTx,
  schema: string,
  t: MirroredTable,
): Promise<void> {
  const target = `${schema}.${t.name}`;
  await tx.execute(
    sql.raw(
      `CREATE TABLE ${target} (LIKE public.${t.name} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`,
    ),
  );
  for (const c of t.omit) {
    await tx.execute(
      sql.raw(`ALTER TABLE ${target} DROP COLUMN IF EXISTS ${c} CASCADE`),
    );
  }
  const indexes = await executeRows(tx, {
    query: sql.raw(
      `SELECT pg_get_indexdef(x.indexrelid) AS def, i.relname::text AS index,
              con.conname::text AS constraint, x.indisexclusion AS exclusion
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       LEFT JOIN pg_constraint con ON con.conindid = x.indexrelid AND con.conrelid = x.indrelid
       WHERE x.indrelid = ${lit(target)}::regclass
         AND (x.indisunique OR x.indisexclusion) AND NOT x.indisprimary`,
    ),
    row: IndexRowSchema,
    label: `table-mirror: unique indexes of ${target}`,
  });
  for (const ix of indexes) {
    await tx.execute(
      sql.raw(
        ix.constraint === null
          ? `DROP INDEX ${schema}.${ix.index}`
          : `ALTER TABLE ${target} DROP CONSTRAINT ${ix.constraint}`,
      ),
    );
    if (ix.exclusion) continue;
    const plain = ix.def
      .replace(/^CREATE UNIQUE INDEX/, "CREATE INDEX")
      .replace(/ NULLS NOT DISTINCT/, "");
    await tx.execute(sql.raw(plain));
  }
}

/**
 * The local table changed (a migration of `public.<t>`): build the mirror
 * table again LIKE it, with no network — the old one moved aside, its rows
 * copied across by column name (a changed type cast to the new one), then
 * dropped, all in the caller's transaction. Rows are kept only when every
 * key column survives and every new column can be left out (nullable or
 * defaulted); otherwise the table starts empty and the reconcile that follows
 * fetches it. Either way the reconcile fetches only the rows that differ.
 * Answers whether the rows were kept.
 */
async function rebuild(
  tx: ReplicaTx,
  schema: string,
  t: MirroredTable,
): Promise<boolean> {
  const scratch = `${schema}_r`;
  await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`));
  await tx.execute(sql.raw(`CREATE SCHEMA ${scratch}`));
  await tx.execute(
    sql.raw(`ALTER TABLE ${schema}.${t.name} SET SCHEMA ${scratch}`),
  );
  await createLike(tx, schema, t);
  const next = await columnsOf(tx, schema, t.name);
  const prev = new Map(
    (await columnsOf(tx, scratch, t.name)).map((c) => [c.name, c]),
  );
  const common = next.filter((c) => prev.has(c.name));
  const keysSurvive = t.pk.every((k) => prev.has(k.name));
  const newOnesOptional = next.every(
    (c) => prev.has(c.name) || !c.notnull || c.hasdef,
  );
  let kept = false;
  if (keysSurvive && newOnesOptional) {
    const cols = common.map((c) => c.name).join(", ");
    const values = common
      .map((c) =>
        prev.get(c.name)!.type === c.type ? c.name : `${c.name}::${c.type}`,
      )
      .join(", ");
    // In a savepoint: old rows the new DDL refuses (a cast that fails, a NULL
    // in a column the migration made NOT NULL) leave the table empty for the
    // reconcile to refill, instead of failing every pull from then on.
    kept = await tx
      .transaction(async (sp) => {
        // sql-writes:hand-written — the local rebuild copies the old mirror table's shared columns into the new one
        await sp.execute(
          sql.raw(
            `INSERT INTO ${schema}.${t.name} (${cols}) SELECT ${values} FROM ${scratch}.${t.name}`,
          ),
        );
        return true;
      })
      .catch((err: unknown) => {
        if (refusedByNewDdl(err)) return false;
        throw err;
      });
  }
  await tx.execute(sql.raw(`DROP SCHEMA ${scratch} CASCADE`));
  return kept;
}

/**
 * The database refused the old rows under the new DDL: SQLSTATE class 22
 * (data exception — a cast that fails) or 23 (integrity — a NULL in a column
 * now NOT NULL). Read off the error's `code`, which every host's driver sets.
 */
function refusedByNewDdl(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^2[23]/.test(code);
}

const TableNameSchema = z.object({ name: z.string() });

/** What preparing a sink did to the local side. */
export interface PreparedSink {
  /** Tables created or rebuilt: their rows must be reconciled. */
  changed: string[];
  /** A rebuilt table could not keep its rows: the copy is partial until a reconcile refills it. */
  emptied: boolean;
}

/**
 * Make the replica's schema match the set as this install declares it: the
 * schema and every missing table created, a table whose local DDL changed
 * rebuilt (its fingerprint — the same catalog digest the source sends —
 * differs from the local one's), a table the set no longer lists dropped.
 */
export async function prepareSchema(
  tx: ReplicaTx,
  schema: string,
  set: MirrorSetDefinition,
): Promise<PreparedSink> {
  await tx.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`));
  const existing = new Set(
    (
      await executeRows(tx, {
        query: sql.raw(
          `SELECT c.relname::text AS name FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${lit(schema)} AND c.relkind IN ('r', 'p')`,
        ),
        row: TableNameSchema,
        label: "table-mirror: replica tables",
      })
    ).map((r) => r.name),
  );
  const declared = new Set(set.tables.map((t) => t.name));
  for (const name of existing) {
    if (!declared.has(name)) {
      await tx.execute(sql.raw(`DROP TABLE ${schema}.${name}`));
    }
  }
  const local = await readTableFingerprints(tx, "public", set.tables);
  const mirror = await readTableFingerprints(tx, schema, set.tables);
  const changed: string[] = [];
  let emptied = false;
  for (const t of set.tables) {
    if (local[t.name] === undefined) {
      throw new Error(
        `table-mirror: set "${set.id}" mirrors ${t.name}, but this database has no public.${t.name} to copy its DDL from`,
      );
    }
    if (!existing.has(t.name)) {
      await createLike(tx, schema, t);
      changed.push(t.name);
    } else if (mirror[t.name] !== local[t.name]) {
      if (!(await rebuild(tx, schema, t))) emptied = true;
      changed.push(t.name);
    }
  }
  return { changed, emptied };
}

const RowObjectSchema = z.record(z.string(), z.unknown());

/** A row's column names, sorted — parsed for the names only; the values travel as the source's text. */
export function rowColumns(row: string): string[] {
  return Object.keys(RowObjectSchema.parse(JSON.parse(row))).sort();
}

/**
 * The source does not send a column this computer's table requires (NOT NULL,
 * no default): a row cannot be written without it. The source runs an older
 * release — deploy it again.
 */
export class SourceOlderError extends Error {
  constructor(
    readonly table: string,
    readonly columns: readonly string[],
  ) {
    super(
      `table-mirror: the source sends no ${columns.join(", ")} for ${table}, which this computer's table requires — the source runs an older release`,
    );
    this.name = "SourceOlderError";
  }
}

/**
 * Apply one table's part of a page in the caller's transaction: tombstoned
 * keys deleted, then rows upserted. Values stay in Postgres's own text forms
 * (`to_jsonb` on the source; its jsonb text joined into one array literal and
 * `jsonb_populate_recordset` here — never a JS value in between). Only the
 * columns both sides have are written: a column the source lacks keeps its
 * default on insert and its value on update; one the source has extra is
 * ignored.
 */
export async function applyToSchema(
  tx: ReplicaTx,
  schema: string,
  t: MirroredTable,
  upserts: readonly MirrorKeyedRow[],
  deletes: readonly MirrorPk[],
): Promise<void> {
  const target = `${schema}.${t.name}`;
  const keyCols = t.pk.map((c) => c.name).join(", ");
  if (deletes.length > 0) {
    // sql-writes:hand-written — tombstoned keys deleted from a replica table named per replica
    await tx.execute(
      sql`DELETE FROM ${sql.raw(target)} WHERE (${sql.raw(keyCols)}) IN (SELECT ${sql.raw(keyCols)} FROM jsonb_populate_recordset(NULL::${sql.raw(target)}, ${JSON.stringify(deletes)}::jsonb))`,
    );
  }
  if (upserts.length === 0) return;
  const sent = rowColumns(upserts[0]!.row);
  const sentKey = sent.join(",");
  for (const r of upserts) {
    const own = rowColumns(r.row).join(",");
    if (own !== sentKey) {
      throw new Error(
        `table-mirror: rows of ${t.name} in one page carry different columns (${sentKey} vs ${own})`,
      );
    }
  }
  const local = await columnsOf(tx, schema, t.name);
  const sentSet = new Set(sent);
  const required = local
    .filter((c) => c.notnull && !c.hasdef && !sentSet.has(c.name))
    .map((c) => c.name);
  if (required.length > 0) throw new SourceOlderError(t.name, required);
  const cols = local.filter((c) => sentSet.has(c.name)).map((c) => c.name);
  const keys = new Set(t.pk.map((c) => c.name));
  const updates = cols.filter((c) => !keys.has(c));
  const onConflict =
    updates.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;
  const list = cols.join(", ");
  await tx.execute(
    sql`INSERT INTO ${sql.raw(target)} (${sql.raw(list)}) SELECT ${sql.raw(list)} FROM jsonb_populate_recordset(NULL::${sql.raw(target)}, ${`[${upserts.map((r) => r.row).join(",")}]`}::jsonb) ON CONFLICT (${sql.raw(keyCols)}) ${sql.raw(onConflict)}`,
  );
}

const KeyHashRowSchema = z.object({
  pk: z.record(z.string(), z.unknown()),
  h: z.string(),
});

/**
 * The replica's own `(pk, h)` over keys in `(afterPk, lastPk]` (to +∞ when
 * `lastPk` is null), in the source's key order, the hash over `columns` — the
 * source's row hash expression over the same columns, so equal rows hash
 * equal. The caller's transaction must run under `TimeZone = 'UTC'`.
 */
export async function schemaKeyHashes(
  exec: Exec,
  schema: string,
  t: MirroredTable,
  columns: readonly string[],
  afterPk: MirrorPk | null,
  lastPk: MirrorPk | null,
): Promise<KeyHash[]> {
  const own = await mirrorColumns(exec, schema, t);
  const dropped = own.filter((c) => !columns.includes(c));
  const json =
    dropped.length === 0
      ? "to_jsonb(t)"
      : `(to_jsonb(t) - ${textArray(dropped)})`;
  const from: string[] = [`${schema}.${t.name} t`];
  const where: string[] = [];
  if (afterPk !== null) {
    from.push(
      `${typedKey(t, `${lit(JSON.stringify(afterPk))}::jsonb`, schema)} a`,
    );
    where.push(`ROW(${pkOrder(t, "t")}) > ROW(${pkOrder(t, "a")})`);
  }
  if (lastPk !== null) {
    from.push(
      `${typedKey(t, `${lit(JSON.stringify(lastPk))}::jsonb`, schema)} b`,
    );
    where.push(`ROW(${pkOrder(t, "t")}) <= ROW(${pkOrder(t, "b")})`);
  }
  return executeRows(exec, {
    query: sql.raw(
      `SELECT ${pkJson(t, "t")} AS pk, ${rowHash(json)} AS h
       FROM ${from.join(", ")}
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY ${pkOrder(t, "t")}`,
    ),
    row: KeyHashRowSchema,
    label: `table-mirror: key hashes of ${schema}.${t.name}`,
  });
}
