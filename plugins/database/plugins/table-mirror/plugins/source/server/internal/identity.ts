import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  executeOne,
  executeRows,
  type SqlExecutable,
} from "@plugins/database/plugins/sql-rows/core";
import type {
  SourceIdentity,
  TableFingerprints,
  Xid8,
} from "@plugins/database/plugins/table-mirror/core";
import { lit, textArray } from "./sql";

const IdentityRowSchema = z.object({
  source_id: z.string(),
  system_identifier: z.string(),
  epoch: z.number(),
  horizon: z.string(),
});

/**
 * This source's identity and log horizon. The row is seeded at boot
 * (`installMirrorSource`), so a missing row is a broken boot, and throws.
 */
export async function readSourceIdentity(
  exec: SqlExecutable<SQL>,
): Promise<{ identity: SourceIdentity; horizon: Xid8 }> {
  const row = await executeOne(exec, {
    query: sql.raw(
      `SELECT s.source_id::text AS source_id,
              (pg_control_system()).system_identifier::text AS system_identifier,
              s.epoch, s.horizon::text AS horizon
       FROM table_mirror_source s WHERE s.singleton`,
    ),
    row: IdentityRowSchema,
    label:
      "table-mirror: readSourceIdentity (seeded at boot by installMirrorSource)",
  });
  return {
    identity: {
      sourceId: row.source_id,
      systemIdentifier: row.system_identifier,
      epoch: row.epoch,
    },
    horizon: row.horizon,
  };
}

const FingerprintRowSchema = z.object({ tbl: z.string(), fp: z.string() });

/**
 * Per table of `schema`: sha256 (hex) over its `(column, type, not null)`
 * lines, sorted by column, `omit` columns left out — read from the catalog, so
 * a replica computes the same over its own schema. A table that does not exist
 * is absent from the answer.
 */
export async function readTableFingerprints(
  exec: SqlExecutable<SQL>,
  schema: string,
  tables: readonly { name: string; omit: readonly string[] }[],
): Promise<TableFingerprints> {
  if (tables.length === 0) return {};
  const omitted = tables.flatMap((t) => t.omit.map((c) => `${t.name}.${c}`));
  const rows = await executeRows(exec, {
    query: sql.raw(
      `SELECT c.relname::text AS tbl,
              encode(sha256(convert_to(string_agg(
                a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text,
                E'\\n' ORDER BY a.attname), 'UTF8')), 'hex') AS fp
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${lit(schema)}
         AND c.relname = ANY(${textArray(tables.map((t) => t.name))})
         AND a.attnum > 0 AND NOT a.attisdropped
         AND NOT ((c.relname::text || '.' || a.attname::text) = ANY(${textArray(omitted)}))
       GROUP BY c.relname`,
    ),
    row: FingerprintRowSchema,
    label: "table-mirror: readTableFingerprints",
  });
  return Object.fromEntries(rows.map((r) => [r.tbl, r.fp]));
}
