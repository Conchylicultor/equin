import { z } from "zod";

// The table mirror's wire protocol: what a source answers and a replica reads.
// Every value is plain JSON, so the transport (an SSH curl, an in-process call)
// carries it as-is. See research/2026-11-12-global-table-mirror.md.

/**
 * How long the source keeps its change log (`table_mirror_log`), in days. A
 * replica whose cursor is older than that can no longer read deltas and
 * reconciles instead (key + hash). The source's daily prune deletes every log
 * row below the newest mark at least this old.
 */
export const TOMBSTONE_RETENTION_DAYS = 30;

/**
 * Default bounds of one page, whichever comes first. A page must answer within
 * the transport's deadline (one curl over SSH, 10 s); the byte cap is enforced
 * by the source while it reads (a running sum), and re-checked by the
 * transport.
 */
export const MIRROR_PAGE_MAX_ROWS = 2000;
export const MIRROR_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Default bound of one key + hash page (about 40 bytes per key). */
export const MIRROR_KEYS_MAX = 20_000;

/** An xid8 as decimal text: compared as BigInt, never lexically, never a JS number. */
export const Xid8Schema = z.string().regex(/^\d+$/);
export type Xid8 = z.infer<typeof Xid8Schema>;

/**
 * A row's primary key as a JSON object of its PK columns' database names to
 * their `to_jsonb` values (`{"id": "…"}`, `{"day": "…", "hash": "…"}`). The
 * same spelling on the log, on every page and on the replica.
 */
export const MirrorPkSchema = z.record(z.string(), z.unknown());
export type MirrorPk = z.infer<typeof MirrorPkSchema>;

/**
 * A row's content: `to_jsonb(row)` minus the set's omitted columns, keyed by
 * database column names, in Postgres's own text forms (a replica applies it
 * with `jsonb_populate_recordset`, no JS decode of the values).
 */
export const MirrorRowSchema = z.record(z.string(), z.unknown());
export type MirrorRow = z.infer<typeof MirrorRowSchema>;

/**
 * A row hash: md5 of the row's jsonb text (keys sorted, so canonical) under
 * `TimeZone = 'UTC'`, restricted to the hashed columns. The same expression
 * runs on both sides, in Postgres.
 */
export const RowHashSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** A position in the change log: `(xid, tbl, pk)`, the log's own order. */
export const MirrorLogPositionSchema = z.object({
  xid: Xid8Schema,
  tbl: z.string(),
  pk: MirrorPkSchema,
});
export type MirrorLogPosition = z.infer<typeof MirrorLogPositionSchema>;

/**
 * Where a replica reads the change stream from. Within one pull `floor` stays
 * fixed and `after` advances to the last row taken; when the last page is
 * `done`, the next pull's `floor` is the `xmin` of this pull's FIRST page and
 * `after` is null. Every change committed after that snapshot has an xid at or
 * above its xmin, so nothing is skipped; re-delivered rows are the current
 * state, applied as upserts, so delivering one twice is harmless.
 */
export const MirrorCursorSchema = z.object({
  floor: Xid8Schema,
  after: MirrorLogPositionSchema.nullable(),
});
export type MirrorCursor = z.infer<typeof MirrorCursorSchema>;

/**
 * Who answered. A box re-installed or restored into another cluster changes
 * `sourceId` / `systemIdentifier` (its xids mean nothing to a cursor any
 * more); a TRUNCATE of a mirrored table bumps `epoch` (the log cannot say what
 * it removed). A replica holding another identity reconciles.
 */
export const SourceIdentitySchema = z.object({
  sourceId: z.string().uuid(),
  systemIdentifier: z.string(),
  epoch: z.number().int().nonnegative(),
});
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;

/**
 * Per mirrored table: sha256 (hex) over its `(column, type, not null)` list,
 * omitted columns left out. A change on either side means a migration may
 * have rewritten rows without the triggers seeing them, so the replica
 * reconciles.
 */
export const TableFingerprintsSchema = z.record(
  z.string(),
  z.string().regex(/^[0-9a-f]{64}$/),
);
export type TableFingerprints = z.infer<typeof TableFingerprintsSchema>;

/** What every page carries about its source and its snapshot. */
const PageHeaderSchema = z.object({
  identity: SourceIdentitySchema,
  fingerprints: TableFingerprintsSchema,
  /** `pg_snapshot_xmin` of the snapshot the page was read under. */
  xmin: Xid8Schema,
  /** The source's `now()` (ISO, UTC) in that snapshot's transaction. */
  now: z.string(),
});

export const MirrorChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("upsert"),
    xid: Xid8Schema,
    tbl: z.string(),
    pk: MirrorPkSchema,
    h: RowHashSchema,
    row: MirrorRowSchema,
  }),
  z.object({
    kind: z.literal("tombstone"),
    xid: Xid8Schema,
    tbl: z.string(),
    pk: MirrorPkSchema,
  }),
]);
export type MirrorChange = z.infer<typeof MirrorChangeSchema>;

/** One page of the change stream: current rows plus tombstones, in log order. */
export const MirrorChangesPageSchema = PageHeaderSchema.extend({
  kind: z.literal("changes"),
  changes: z.array(MirrorChangeSchema),
  /** The cursor to ask for the next page with (same floor). */
  next: MirrorCursorSchema,
  /** No log row is left past `next` in this snapshot. */
  done: z.boolean(),
});
export type MirrorChangesPage = z.infer<typeof MirrorChangesPageSchema>;

/** A row with its key and hash, as a copy page or a rows answer carries it. */
export const MirrorKeyedRowSchema = z.object({
  pk: MirrorPkSchema,
  h: RowHashSchema,
  row: MirrorRowSchema,
});
export type MirrorKeyedRow = z.infer<typeof MirrorKeyedRowSchema>;

/** One keyset page of a whole table: a replica's first sync only. */
export const MirrorCopyPageSchema = PageHeaderSchema.extend({
  kind: z.literal("copy"),
  table: z.string(),
  rows: z.array(MirrorKeyedRowSchema),
  /** The last key taken: ask for the next page after it. Null on an empty page. */
  lastPk: MirrorPkSchema.nullable(),
  done: z.boolean(),
});
export type MirrorCopyPage = z.infer<typeof MirrorCopyPageSchema>;

/**
 * One keyset page of `(pk, h)` for reconciliation. The page covers keys in
 * `(afterPk, lastPk]` — to +∞ when `done`. `columns` is what the hash covers:
 * the replica's columns that the source also has (omitted ones never), so the
 * replica hashes its own rows over exactly that list.
 */
export const MirrorKeysPageSchema = PageHeaderSchema.extend({
  kind: z.literal("keys"),
  table: z.string(),
  columns: z.array(z.string()),
  keys: z.array(z.object({ pk: MirrorPkSchema, h: RowHashSchema })),
  lastPk: MirrorPkSchema.nullable(),
  done: z.boolean(),
});
export type MirrorKeysPage = z.infer<typeof MirrorKeysPageSchema>;

/**
 * The current rows for a bounded list of keys. `missing` are keys the source
 * no longer has (deleted since the keys page; the change stream from the
 * reconcile's floor carries their tombstones). `remaining` are keys not taken
 * because the byte cap was reached: ask again with them.
 */
export const MirrorRowsAnswerSchema = PageHeaderSchema.extend({
  kind: z.literal("rows"),
  table: z.string(),
  columns: z.array(z.string()),
  rows: z.array(MirrorKeyedRowSchema),
  missing: z.array(MirrorPkSchema),
  remaining: z.array(MirrorPkSchema),
});
export type MirrorRowsAnswer = z.infer<typeof MirrorRowsAnswerSchema>;

/**
 * A source's named refusals. `reconcile-required`: the cursor's floor is below
 * the log horizon, so tombstones it needs were pruned — never a partial page.
 * `unknown-set` / `unknown-table`: this source does not mirror it (an older or
 * newer release).
 */
export const MirrorRefusalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reconcile-required"),
    horizon: Xid8Schema,
    identity: SourceIdentitySchema,
  }),
  z.object({ kind: z.literal("unknown-set"), setId: z.string() }),
  z.object({
    kind: z.literal("unknown-table"),
    setId: z.string(),
    table: z.string(),
  }),
]);
export type MirrorRefusal = z.infer<typeof MirrorRefusalSchema>;

// The requests, as a transport carries them.

const PageBoundsSchema = z.object({
  maxRows: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
});

export const MirrorChangesRequestSchema = PageBoundsSchema.extend({
  setId: z.string(),
  cursor: MirrorCursorSchema,
});
export type MirrorChangesRequest = z.infer<typeof MirrorChangesRequestSchema>;

export const MirrorCopyRequestSchema = PageBoundsSchema.extend({
  setId: z.string(),
  table: z.string(),
  afterPk: MirrorPkSchema.nullable(),
});
export type MirrorCopyRequest = z.infer<typeof MirrorCopyRequestSchema>;

export const MirrorKeysRequestSchema = z.object({
  setId: z.string(),
  table: z.string(),
  /** The replica's columns: the hash covers those the source also has. */
  columns: z.array(z.string()),
  afterPk: MirrorPkSchema.nullable(),
  maxKeys: z.number().int().positive().optional(),
});
export type MirrorKeysRequest = z.infer<typeof MirrorKeysRequestSchema>;

export const MirrorRowsRequestSchema = z.object({
  setId: z.string(),
  table: z.string(),
  columns: z.array(z.string()),
  pks: z.array(MirrorPkSchema).max(MIRROR_PAGE_MAX_ROWS),
  maxBytes: z.number().int().positive().optional(),
});
export type MirrorRowsRequest = z.infer<typeof MirrorRowsRequestSchema>;
