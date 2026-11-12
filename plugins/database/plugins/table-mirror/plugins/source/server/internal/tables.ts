import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Postgres `xid8`: the 64-bit transaction id, which never wraps for the life of
// a cluster. Kept as decimal text in JS (never a number near 2^63).
const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "xid8";
  },
});

/**
 * The change log: one row per primary key of a mirrored table ever changed,
 * until pruned — the key, the xid of the last transaction that changed it, and
 * whether that change deleted it. Written only by the generated statement
 * triggers (`./triggers.ts`), read by the change stream in `(xid, tbl, pk)`
 * order, pruned below the horizon by the daily `table-mirror.prune` job, so it
 * holds the last `TOMBSTONE_RETENTION_DAYS` of changes, not the tables.
 */
export const tableMirrorLog = pgTable(
  "table_mirror_log",
  {
    setId: text("set_id").notNull(),
    tbl: text("tbl").notNull(),
    pk: jsonb("pk").notNull(),
    xid: xid8("xid").notNull(),
    deleted: boolean("deleted").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tbl, t.pk] }),
    index("table_mirror_log_set_xid_idx").on(t.setId, t.xid, t.tbl, t.pk),
  ],
);

/**
 * This source's identity, one row: a random id minted on first boot, the epoch
 * a TRUNCATE of a mirrored table bumps, and the log horizon (every log row
 * below it was pruned). Seeded at boot by `installMirrorSource`.
 */
export const tableMirrorSource = pgTable(
  "table_mirror_source",
  {
    /** Always true: the table holds one row. */
    singleton: boolean("singleton").primaryKey().default(true),
    sourceId: uuid("source_id").notNull(),
    epoch: integer("epoch").notNull().default(0),
    horizon: xid8("horizon")
      .notNull()
      .default(sql`'0'::xid8`),
  },
  (t) => [check("table_mirror_source_one_row", sql`${t.singleton}`)],
);

/**
 * The prune job's marks: one `(when, snapshot xmin)` per run. The prune deletes
 * log rows below the newest mark at least `TOMBSTONE_RETENTION_DAYS` old, then
 * the marks older than it.
 */
export const tableMirrorMarks = pgTable("table_mirror_marks", {
  at: timestamp("at", { withTimezone: true }).primaryKey(),
  snapshotXmin: xid8("snapshot_xmin").notNull(),
});
