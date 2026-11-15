import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { differingParts, schemaLayerStamp, STATE } from "./layer-stamp";
import {
  planSchemaSteps,
  type Migration,
  type SchemaLayerInputs,
} from "./runner";

/** What a verifier found (`verifySchemaLayer`). */
export type SchemaLayerCheck =
  | { readonly kind: "ready" }
  | { readonly kind: "not-ready"; readonly detail: string };

/** Postgres `undefined_table`: the owner has never written a stamp here. */
const UNDEFINED_TABLE = "42P01";

/**
 * Whether the database's owner set the schema up for exactly this code. Two
 * reads, no lock beyond ACCESS SHARE on two bookkeeping tables, no DDL:
 *
 * 1. The migrations ledger holds every migration this code's plan would apply
 *    (`planSchemaSteps` over it, the boot's deferred contract allowed) — read
 *    directly, because every owner keeps the ledger, old code included: a stamp
 *    left by newer code that was then reverted, or one a fork copied from
 *    main, can never admit a child onto a database missing its migrations.
 * 2. The stored stamp equals `schemaLayerStamp(migrations, inputs)` — the
 *    derived layer (views, triggers, rollups) this code declares.
 */
export async function verifySchemaLayer(
  db: NodePgDatabase,
  migrations: readonly Migration[],
  inputs: SchemaLayerInputs,
): Promise<SchemaLayerCheck> {
  const expected = schemaLayerStamp(migrations, inputs);
  const pending = await pendingMigrations(db, migrations);
  if (pending.length > 0) {
    return {
      kind: "not-ready",
      detail: `${String(pending.length)} of this code's migrations are not applied (${pending.slice(0, 3).join(", ")}${pending.length > 3 ? ", …" : ""}) — a push is usually mid-deploy, and its backend applies them when it boots`,
    };
  }
  const stored = await storedStamp(db);
  if (stored === null) {
    return {
      kind: "not-ready",
      detail:
        "no schema-layer stamp in this database — its serving backend has not booted code that records one",
    };
  }
  if (stored.stamp === expected) return { kind: "ready" };
  return {
    kind: "not-ready",
    detail: `the serving backend last set it up (at ${stored.written_at}) for code whose ${differingParts(stored.stamp, expected).join(", ")} differ from this code's — a push is usually mid-deploy, and its backend sets the schema up when it boots`,
  };
}

async function pendingMigrations(
  db: NodePgDatabase,
  migrations: readonly Migration[],
): Promise<string[]> {
  let rows: { hash: string; contract_pending: boolean }[];
  try {
    rows = await executeRows(db, {
      query: drizzleSql`SELECT hash, coalesce(contract_pending, false) AS contract_pending FROM ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)}`,
      row: z.object({ hash: z.string(), contract_pending: z.boolean() }),
      label: "migrations: read the ledger (verifier)",
    });
  } catch (err) {
    // No ledger (or one from before `contract_pending`): nothing this code
    // can trust — every migration counts as pending.
    if (!isUndefinedObject(err)) throw err;
    return migrations.map((m) => m.file);
  }
  const plan = planSchemaSteps(
    [...migrations],
    new Set(rows.map((r) => r.hash)),
    {
      contractPending: new Set(
        rows.filter((r) => r.contract_pending).map((r) => r.hash),
      ),
      deferContract: true,
    },
  );
  return plan.pendingFiles;
}

async function storedStamp(
  db: NodePgDatabase,
): Promise<{ stamp: string; written_at: string } | null> {
  try {
    const rows = await executeRows(db, {
      query: drizzleSql`SELECT stamp, written_at::text AS written_at FROM ${STATE}`,
      row: z.object({ stamp: z.string(), written_at: z.string() }),
      label: "migrations: read schema-layer stamp",
    });
    return rows[0] ?? null;
  } catch (err) {
    if (!isUndefinedObject(err)) throw err;
    return null;
  }
}

/** `undefined_table` (42P01) or `undefined_column` (42703), anywhere in the cause chain. */
function isUndefinedObject(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (code === UNDEFINED_TABLE || code === "42703") return true;
  }
  return false;
}
