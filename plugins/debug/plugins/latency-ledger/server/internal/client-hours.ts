import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { InteractionSchema } from "../../core";

const InteractionKindSchema = InteractionSchema.shape.kind;

/** One client's page loads (or navigations) of one route in one UTC clock hour. */
export interface ClientHour {
  clientId: string;
  kind: z.infer<typeof InteractionKindSchema>;
  route: string;
  /** Epoch ms of the hour's start. */
  hourStart: number;
  count: number;
  /** Any of them was driven by automation (`navigator.webdriver`). */
  automated: boolean;
}

const ClientHourRowSchema = z.object({
  client_id: z.string(),
  kind: InteractionKindSchema,
  route: z.string(),
  hour_start: z.coerce.date(),
  n: z.coerce.number(),
  automated: z.boolean(),
});

/**
 * Every (client, kind, route, UTC clock hour) with at least one interaction in
 * `[from, to)`, with its count. A row with no client (from a bundle that
 * predates the field) belongs to no client and is not counted.
 */
export async function readClientHours(
  from: Date,
  to: Date,
): Promise<ClientHour[]> {
  const rows = await executeRows(db, {
    label: "latency-ledger:client-hours",
    row: ClientHourRowSchema,
    query: sql`
      SELECT client_id, kind, route,
             -- UTC, not the session's zone: the caller's hours are UTC.
             date_trunc('hour', occurred_at, 'UTC') AS hour_start,
             count(*)::int8 AS n,
             bool_or(automated) AS automated
      FROM latency_ledger_interaction
      WHERE occurred_at >= ${from} AND occurred_at < ${to}
        AND client_id IS NOT NULL
      GROUP BY 1, 2, 3, 4`,
  });
  return rows.map((r) => ({
    clientId: r.client_id,
    kind: r.kind,
    route: r.route,
    hourStart: r.hour_start.getTime(),
    count: r.n,
    automated: r.automated,
  }));
}

/** The routes one client's interactions of one kind went to in `[from, to)`, busiest first. */
export async function readClientRoutes(
  clientId: string,
  kind: ClientHour["kind"],
  from: Date,
  to: Date,
  limit: number,
): Promise<{ route: string; count: number }[]> {
  const rows = await executeRows(db, {
    label: "latency-ledger:client-routes",
    row: z.object({ route: z.string(), n: z.coerce.number() }),
    query: sql`
      SELECT route, count(*)::int8 AS n
      FROM latency_ledger_interaction
      WHERE client_id = ${clientId} AND kind = ${kind}
        AND occurred_at >= ${from} AND occurred_at < ${to}
      GROUP BY 1
      ORDER BY 2 DESC, 1
      LIMIT ${limit}`,
  });
  return rows.map((r) => ({ route: r.route, count: r.n }));
}
