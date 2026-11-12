import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import {
  MIRROR_KEYS_MAX,
  MIRROR_PAGE_MAX_BYTES,
  MIRROR_PAGE_MAX_ROWS,
  type MirrorChange,
  type MirrorChangesPage,
  type MirrorCopyPage,
  type MirrorCursor,
  type MirrorKeysPage,
  type MirrorPk,
  type MirrorRefusal,
  type MirrorRowsAnswer,
  type SourceIdentity,
  type TableFingerprints,
} from "@plugins/database/plugins/table-mirror/core";
import type { MirroredTable, MirrorSetDefinition } from "./define";
import { readSourceIdentity, readTableFingerprints } from "./identity";
import {
  lit,
  pkAfter,
  pkJson,
  pkMatch,
  pkOrder,
  rowHash,
  rowJson,
  typedKey,
} from "./sql";

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

// Every reader runs in ONE read-only REPEATABLE READ transaction: the page's
// rows, its identity and fingerprints and its `xmin` all come from the same
// snapshot. `TimeZone = 'UTC'` makes a timestamptz render the same text on
// both sides, so the row hash agrees.
async function inSnapshot<T>(
  db: NodePgDatabase,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL TimeZone = 'UTC'`));
      return fn(tx);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const HeaderRowSchema = z.object({ xmin: z.string(), now: z.string() });

interface Header {
  identity: SourceIdentity;
  fingerprints: TableFingerprints;
  xmin: string;
  now: string;
  horizon: string;
}

async function readHeader(tx: Tx, set: MirrorSetDefinition): Promise<Header> {
  // First statement of the transaction: it takes the snapshot every later
  // read of the page shares, so `xmin` is that snapshot's.
  const { xmin, now } = await executeOne(tx, {
    query: sql.raw(
      `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
              to_jsonb(now()) #>> '{}' AS now`,
    ),
    row: HeaderRowSchema,
    label: "table-mirror: page header",
  });
  const { identity, horizon } = await readSourceIdentity(tx);
  const fingerprints = await readTableFingerprints(tx, "public", set.tables);
  return { identity, fingerprints, xmin, now, horizon };
}

/**
 * Wrap a keyset `inner` select (already ordered, carrying `order` columns) so
 * the database cuts it at `maxRows` and at a running byte sum of `maxBytes` —
 * the first row always taken, so one large row still moves. The LIMIT runs
 * before the windows, so a page reads at most `maxRows + 1` rows. `_fetched`
 * tells whether anything was left past the cut.
 */
function boundedPage(
  inner: string,
  order: string,
  len: string,
  maxRows: number,
  maxBytes: number,
): string {
  return `SELECT * FROM (
    SELECT p.*,
      row_number() OVER w AS _rn,
      sum(${len}) OVER w AS _running,
      count(*) OVER () AS _fetched
    FROM (${inner} LIMIT ${maxRows + 1}) p
    WINDOW w AS (ORDER BY ${order} ROWS UNBOUNDED PRECEDING)
  ) s
  WHERE s._rn <= ${maxRows} AND (s._running <= ${maxBytes} OR s._rn = 1)
  ORDER BY s._rn`;
}

const BoundRowSchema = z.object({
  _rn: z.coerce.number(),
  _fetched: z.coerce.number(),
});

function isDone(rows: readonly { _fetched: number }[]): boolean {
  return rows.length === (rows[0]?._fetched ?? 0);
}

function positiveInt(
  value: number | undefined,
  fallback: number,
  what: string,
): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `table-mirror: ${what} must be a positive integer, got ${n}`,
    );
  }
  return n;
}

function findTable(
  set: MirrorSetDefinition,
  table: string,
): MirroredTable | MirrorRefusal {
  return (
    set.tables.find((t) => t.name === table) ?? {
      kind: "unknown-table",
      setId: set.id,
      table,
    }
  );
}

// ── The change stream ────────────────────────────────────────────────────────

const ChangeRowSchema = BoundRowSchema.extend({
  xid: z.string(),
  tbl: z.string(),
  pk: z.record(z.string(), z.unknown()),
  deleted: z.boolean(),
  row: z.string().nullable(),
  h: z.string().nullable(),
});

export interface ReadMirrorChangesOptions {
  set: MirrorSetDefinition;
  cursor: MirrorCursor;
  maxRows?: number;
  maxBytes?: number;
}

/**
 * One page of the change stream after `cursor`: for each log row in
 * `(xid, tbl, pk)` order, the row's current content and hash (an upsert) or
 * its key (a tombstone). A floor below the log horizon is refused with
 * `reconcile-required` — never a partial page.
 */
export async function readMirrorChanges(
  db: NodePgDatabase,
  opts: ReadMirrorChangesOptions,
): Promise<MirrorChangesPage | MirrorRefusal> {
  const { set, cursor } = opts;
  const maxRows = positiveInt(opts.maxRows, MIRROR_PAGE_MAX_ROWS, "maxRows");
  const maxBytes = positiveInt(
    opts.maxBytes,
    MIRROR_PAGE_MAX_BYTES,
    "maxBytes",
  );
  return inSnapshot(db, async (tx) => {
    const header = await readHeader(tx, set);
    if (BigInt(cursor.floor) < BigInt(header.horizon)) {
      return {
        kind: "reconcile-required",
        horizon: header.horizon,
        identity: header.identity,
      };
    }
    const after =
      cursor.after === null
        ? ""
        : ` AND (l.xid, l.tbl, l.pk) > (${lit(cursor.after.xid)}::xid8, ${lit(cursor.after.tbl)}, ${lit(JSON.stringify(cursor.after.pk))}::jsonb)`;
    // Each log row is joined to its table by key — one branch per table,
    // evaluated only for that table's rows.
    const content = `CASE WHEN l.deleted THEN NULL ELSE CASE l.tbl ${set.tables
      .map(
        (t) =>
          `WHEN ${lit(t.name)} THEN (SELECT ${rowJson(t, "t", null)} FROM public.${t.name} t, ${typedKey(t, "l.pk")} k WHERE ${pkMatch(t, "t", "k")})`,
      )
      .join(" ")} END END`;
    const inner = `SELECT l.xid, l.tbl, l.pk, l.deleted, ${content} AS row
      FROM table_mirror_log l
      WHERE l.set_id = ${lit(set.id)} AND l.xid >= ${lit(cursor.floor)}::xid8${after}
      ORDER BY l.xid, l.tbl, l.pk`;
    const paged = boundedPage(
      inner,
      "p.xid, p.tbl, p.pk",
      "octet_length(p.pk::text) + coalesce(octet_length(p.row::text), 0)",
      maxRows,
      maxBytes,
    );
    const rows = await executeRows(tx, {
      query: sql.raw(
        `SELECT q.xid::text AS xid, q.tbl, q.pk, q.deleted, q.row::text AS row,
                CASE WHEN q.row IS NULL THEN NULL ELSE ${rowHash("q.row")} END AS h,
                q._rn, q._fetched
         FROM (${paged}) q ORDER BY q._rn`,
      ),
      row: ChangeRowSchema,
      label: "table-mirror: readMirrorChanges",
    });
    const changes = rows.map((r): MirrorChange => {
      if (r.deleted)
        return { kind: "tombstone", xid: r.xid, tbl: r.tbl, pk: r.pk };
      if (r.row === null || r.h === null) {
        // The trigger flips the log row in the transaction that deletes the
        // table row, so an upsert always has its row in the same snapshot.
        // Seeing none means a write bypassed the triggers.
        throw new Error(
          `table-mirror: log row ${r.tbl} ${JSON.stringify(r.pk)} (xid ${r.xid}) says upsert but the table has no such row — a write bypassed the change-log triggers`,
        );
      }
      return {
        kind: "upsert",
        xid: r.xid,
        tbl: r.tbl,
        pk: r.pk,
        h: r.h,
        row: r.row,
      };
    });
    const last = changes.at(-1);
    return {
      kind: "changes",
      identity: header.identity,
      fingerprints: header.fingerprints,
      xmin: header.xmin,
      now: header.now,
      changes,
      next: {
        floor: cursor.floor,
        after:
          last === undefined
            ? cursor.after
            : { xid: last.xid, tbl: last.tbl, pk: last.pk },
      },
      done: isDone(rows),
    };
  });
}

// ── Table walks: copy, keys, rows ────────────────────────────────────────────

const KeyedRowSchema = BoundRowSchema.extend({
  pk: z.record(z.string(), z.unknown()),
  h: z.string(),
  row: z.string(),
});

function afterClause(
  t: MirroredTable,
  afterPk: MirrorPk | null,
): { from: string; where: string } {
  if (afterPk === null) return { from: "", where: "" };
  return {
    from: `, ${typedKey(t, `${lit(JSON.stringify(afterPk))}::jsonb`)} a`,
    where: ` WHERE ${pkAfter(t, "t", "a")}`,
  };
}

/** The order columns a keyset inner select carries, and their window order. */
function pkCarry(t: MirroredTable): { select: string; order: string } {
  return {
    select: t.pk.map((c, i) => `t.${c.name} AS _k${i}`).join(", "),
    order: t.pk
      .map((c, i) => `p._k${i}${c.collatable ? ` COLLATE "C"` : ""}`)
      .join(", "),
  };
}

export interface ReadMirrorCopyOptions {
  set: MirrorSetDefinition;
  table: string;
  afterPk: MirrorPk | null;
  maxRows?: number;
  maxBytes?: number;
}

/**
 * One keyset page of a whole table, rows with their hash — a replica's first
 * sync only, when it has nothing to compare against. Its `xmin` is the floor
 * the change stream continues from.
 */
export async function readMirrorCopy(
  db: NodePgDatabase,
  opts: ReadMirrorCopyOptions,
): Promise<MirrorCopyPage | MirrorRefusal> {
  const t = findTable(opts.set, opts.table);
  if ("kind" in t) return t;
  const maxRows = positiveInt(opts.maxRows, MIRROR_PAGE_MAX_ROWS, "maxRows");
  const maxBytes = positiveInt(
    opts.maxBytes,
    MIRROR_PAGE_MAX_BYTES,
    "maxBytes",
  );
  return inSnapshot(db, async (tx) => {
    const header = await readHeader(tx, opts.set);
    const { from, where } = afterClause(t, opts.afterPk);
    const carry = pkCarry(t);
    const inner = `SELECT ${carry.select}, ${pkJson(t, "t")} AS pk, ${rowJson(t, "t", null)} AS row
      FROM public.${t.name} t${from}${where}
      ORDER BY ${pkOrder(t, "t")}`;
    const rows = await executeRows(tx, {
      query: sql.raw(
        `SELECT q.pk, q.row::text AS row, ${rowHash("q.row")} AS h, q._rn, q._fetched
         FROM (${boundedPage(inner, carry.order, "octet_length(p.row::text)", maxRows, maxBytes)}) q
         ORDER BY q._rn`,
      ),
      row: KeyedRowSchema,
      label: "table-mirror: readMirrorCopy",
    });
    return {
      kind: "copy",
      identity: header.identity,
      fingerprints: header.fingerprints,
      xmin: header.xmin,
      now: header.now,
      table: t.name,
      rows: rows.map(({ pk, h, row }) => ({ pk, h, row })),
      lastPk: rows.at(-1)?.pk ?? null,
      done: isDone(rows),
    };
  });
}

/** The columns a hash covers: the requested ones this source also sends. */
function hashedColumns(
  t: MirroredTable,
  requested: readonly string[],
): string[] {
  const asked = new Set(requested);
  return t.columns.filter((c) => asked.has(c));
}

const KeyRowSchema = BoundRowSchema.extend({
  pk: z.record(z.string(), z.unknown()),
  h: z.string(),
});

export interface ReadMirrorKeysOptions {
  set: MirrorSetDefinition;
  table: string;
  /** The replica's columns; the hash covers those this source also sends. */
  columns: readonly string[];
  afterPk: MirrorPk | null;
  maxKeys?: number;
}

/**
 * One keyset page of `(pk, h)` — reconciliation's walk, about 40 bytes a key.
 * The page covers keys in `(afterPk, lastPk]`, to +∞ when `done`.
 */
export async function readMirrorKeys(
  db: NodePgDatabase,
  opts: ReadMirrorKeysOptions,
): Promise<MirrorKeysPage | MirrorRefusal> {
  const t = findTable(opts.set, opts.table);
  if ("kind" in t) return t;
  const maxKeys = positiveInt(opts.maxKeys, MIRROR_KEYS_MAX, "maxKeys");
  const columns = hashedColumns(t, opts.columns);
  return inSnapshot(db, async (tx) => {
    const header = await readHeader(tx, opts.set);
    const { from, where } = afterClause(t, opts.afterPk);
    const carry = pkCarry(t);
    const inner = `SELECT ${carry.select}, ${pkJson(t, "t")} AS pk, ${rowHash(rowJson(t, "t", columns))} AS h
      FROM public.${t.name} t${from}${where}
      ORDER BY ${pkOrder(t, "t")}`;
    // A key page has no byte cap beyond its key count: keys are small.
    const rows = await executeRows(tx, {
      query: sql.raw(
        `SELECT q.pk, q.h, q._rn, q._fetched
         FROM (${boundedPage(inner, carry.order, "0", maxKeys, Number.MAX_SAFE_INTEGER)}) q
         ORDER BY q._rn`,
      ),
      row: KeyRowSchema,
      label: "table-mirror: readMirrorKeys",
    });
    return {
      kind: "keys",
      identity: header.identity,
      fingerprints: header.fingerprints,
      xmin: header.xmin,
      now: header.now,
      table: t.name,
      columns,
      keys: rows.map(({ pk, h }) => ({ pk, h })),
      lastPk: rows.at(-1)?.pk ?? null,
      done: isDone(rows),
    };
  });
}

const RowsRowSchema = z.object({
  ord: z.coerce.number(),
  key: z.record(z.string(), z.unknown()),
  pk: z.record(z.string(), z.unknown()).nullable(),
  row: z.string().nullable(),
  h: z.string().nullable(),
  taken: z.boolean(),
});

export interface ReadMirrorRowsOptions {
  set: MirrorSetDefinition;
  table: string;
  /** The replica's columns; `h` covers those this source also sends. */
  columns: readonly string[];
  pks: readonly MirrorPk[];
  maxBytes?: number;
}

/**
 * The current rows for a bounded list of keys — what reconciliation found
 * different. Keys the source no longer has come back in `missing`; keys past
 * the byte cap in `remaining` (ask again with them).
 */
export async function readMirrorRows(
  db: NodePgDatabase,
  opts: ReadMirrorRowsOptions,
): Promise<MirrorRowsAnswer | MirrorRefusal> {
  const t = findTable(opts.set, opts.table);
  if ("kind" in t) return t;
  if (opts.pks.length > MIRROR_PAGE_MAX_ROWS) {
    throw new Error(
      `table-mirror: readMirrorRows takes at most ${MIRROR_PAGE_MAX_ROWS} keys, got ${opts.pks.length}`,
    );
  }
  const maxBytes = positiveInt(
    opts.maxBytes,
    MIRROR_PAGE_MAX_BYTES,
    "maxBytes",
  );
  const columns = hashedColumns(t, opts.columns);
  return inSnapshot(db, async (tx) => {
    const header = await readHeader(tx, opts.set);
    const base = {
      kind: "rows" as const,
      identity: header.identity,
      fingerprints: header.fingerprints,
      xmin: header.xmin,
      now: header.now,
      table: t.name,
      columns,
    };
    if (opts.pks.length === 0)
      return { ...base, rows: [], missing: [], remaining: [] };
    const present = `t.${t.pk[0]!.name} IS NOT NULL`;
    // The byte cap is applied in the database: a key past it comes back
    // without its content.
    const found = await executeRows(tx, {
      query: sql.raw(
        `SELECT s.ord, s.key,
                CASE WHEN s.taken THEN s.pk END AS pk,
                CASE WHEN s.taken THEN s.row::text END AS row,
                CASE WHEN s.taken THEN s.h END AS h,
                s.taken
         FROM (
           SELECT q.*,
                  (q.ord = 1 OR sum(coalesce(octet_length(q.row::text), 0)) OVER (ORDER BY q.ord ROWS UNBOUNDED PRECEDING) <= ${maxBytes}) AS taken
           FROM (
             SELECT e.ord, e.key,
                    CASE WHEN ${present} THEN ${pkJson(t, "t")} END AS pk,
                    CASE WHEN ${present} THEN ${rowJson(t, "t", null)} END AS row,
                    CASE WHEN ${present} THEN ${rowHash(rowJson(t, "t", columns))} END AS h
             FROM jsonb_array_elements(${lit(JSON.stringify(opts.pks))}::jsonb) WITH ORDINALITY e(key, ord)
             CROSS JOIN LATERAL ${typedKey(t, "e.key")} k
             LEFT JOIN public.${t.name} t ON ${pkMatch(t, "t", "k")}
           ) q
         ) s
         ORDER BY s.ord`,
      ),
      row: RowsRowSchema,
      label: "table-mirror: readMirrorRows",
    });
    const rows: MirrorRowsAnswer["rows"] = [];
    const missing: MirrorPk[] = [];
    const remaining: MirrorPk[] = [];
    for (const r of found) {
      if (!r.taken) remaining.push(r.key);
      else if (r.pk === null || r.row === null || r.h === null)
        missing.push(r.key);
      else rows.push({ pk: r.pk, h: r.h, row: r.row });
    }
    return { ...base, rows, missing, remaining };
  });
}
