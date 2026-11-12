import { and, asc, count, desc, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import type {
  LiveCutKey,
  LiveDecodedGroupQuery,
  LiveDecodedQuery,
  LiveKeyDirection,
} from "@plugins/network/plugins/live/core";
import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { siteMessageIdKind } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { siteMessages } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/server";
import {
  parseSiteMessageRowId,
  siteMessageRowId,
  siteMessagesInbox,
  type SiteMessageRow,
} from "../../core";

// The inbox's questions over one site's `site_messages`, in the intake's own
// table names: `served.ts` runs them inside `readSiteMirror` (a read-only
// snapshot whose search_path is this computer's copy of the site's table),
// a test on a throwaway database's own table. `ip_hash`, which never left
// the box, is never selected.
//
// The window is a keyset on `(created_at cut to ms, id)`: the instant's `$key`
// text is `Date#toISOString()` (what the row's `createdAt` holds), then the
// intake's id in the `C` collation — within one deployment the row id
// (`<deploymentId>/<messageId>`) orders exactly as the message id.

export type WindowQuery = LiveDecodedQuery<
  (typeof siteMessagesInbox.sortable)[number]
>;
export type GroupQuery = LiveDecodedGroupQuery<
  keyof typeof siteMessagesInbox.filterable & string
>;

/** The columns a row is built from — never `ip_hash`, which the copy does not have. */
const COLUMNS = {
  id: siteMessages.id,
  createdAt: siteMessages.createdAt,
  message: siteMessages.message,
  replyTo: siteMessages.replyTo,
  host: siteMessages.host,
  page: siteMessages.page,
  verdict: siteMessages.verdict,
  spamReason: siteMessages.spamReason,
  notifyState: siteMessages.notifyState,
  notifyError: siteMessages.notifyError,
  notifiedAt: siteMessages.notifiedAt,
};

const createdAtMs = sql`date_trunc('milliseconds', ${siteMessages.createdAt})`;

/**
 * The deployment a read names: every read is scoped (`where: { deploymentId }`,
 * ANDed at the top of the canonical filter). `none` when the filter matches
 * nothing at all — the canonical form folds an `and` holding an always-false
 * child into `{ or: [] }`, scope included — so the read answers empty. A read
 * that names no deployment otherwise is a bug in its caller: there is no copy
 * of "every site" to answer it from.
 */
export function deploymentOf(
  where: Filter | undefined,
): { kind: "none" } | { kind: "deployment"; id: string } {
  if (where !== undefined && "or" in where && where.or.length === 0) {
    return { kind: "none" };
  }
  const clauses =
    where === undefined ? [] : "and" in where ? where.and : [where];
  for (const c of clauses) {
    if (
      "column" in c &&
      c.column === "deploymentId" &&
      c.op === "eq" &&
      typeof c.operand === "string"
    ) {
      return { kind: "deployment", id: c.operand };
    }
  }
  throw new Error(
    `deploy-site-messages.inbox: a read names no deployment (where: { deploymentId }) — got ${JSON.stringify(where)}`,
  );
}

/** `where` over one deployment's copy: its scope clause holds by construction. */
function whereSql(deploymentId: string, where: Filter | undefined): SQL {
  const targets = {
    deploymentId: sql`${deploymentId}::text`,
    replyTo: sql`${siteMessages.replyTo}`,
    message: sql`${siteMessages.message}`,
    createdAt: createdAtMs,
    verdict: sql`${siteMessages.verdict}`,
    notifyState: sql`${siteMessages.notifyState}`,
  } satisfies Record<keyof typeof siteMessagesInbox.filterable, SQL>;
  return filterSql(where, targets, siteMessagesInbox.filterable) ?? sql`TRUE`;
}

function toRow(
  deploymentId: string,
  r: {
    id: string;
    createdAt: Date;
    message: string;
    replyTo: string;
    host: string;
    page: string;
    verdict: SiteMessageRow["verdict"];
    spamReason: SiteMessageRow["spamReason"];
    notifyState: SiteMessageRow["notifyState"];
    notifyError: string | null;
    notifiedAt: Date | null;
  },
): SiteMessageRow {
  return {
    ...r,
    id: siteMessageRowId(deploymentId, r.id),
    messageId: r.id,
    deploymentId,
  };
}

/** The window's one order — `createdAt`, the only sort. */
function directionOf(q: WindowQuery): LiveKeyDirection {
  const [first, ...rest] = q.orderBy;
  if (first === undefined || first[0] !== "createdAt" || rest.length > 0) {
    throw new Error(
      `deploy-site-messages.inbox: the window is ordered by \`createdAt\` alone — got ${JSON.stringify(q.orderBy)}`,
    );
  }
  return first[1];
}

/** A cut's instant and message id; a message's `createdAt` is never NULL. */
function cutOf(cut: LiveCutKey, which: string): { at: SQL; id: string } {
  const [instant, rowId] = cut;
  if (instant == null || rowId == null) {
    throw new Error(
      `deploy-site-messages.inbox: the ${which} cut ${JSON.stringify(cut)} has no instant or id`,
    );
  }
  return {
    at: sql`${instant}::timestamptz`,
    id: parseSiteMessageRowId(rowId).messageId,
  };
}

/** Rows strictly past `cut` in the window's order (the instant in `dir`, the id ascending). */
function afterSql(cut: LiveCutKey, dir: LiveKeyDirection): SQL {
  const { at, id } = cutOf(cut, "after");
  return sql`(${createdAtMs} ${sql.raw(dir === "desc" ? "<" : ">")} ${at}
    OR (${createdAtMs} = ${at} AND ${siteMessages.id} COLLATE "C" > ${id}))`;
}

/** Rows at or before `cut` in the window's order. */
function untilSql(cut: LiveCutKey, dir: LiveKeyDirection): SQL {
  const { at, id } = cutOf(cut, "until");
  return sql`(${createdAtMs} ${sql.raw(dir === "desc" ? ">" : "<")} ${at}
    OR (${createdAtMs} = ${at} AND ${siteMessages.id} COLLATE "C" <= ${id}))`;
}

/** A grouped column's value (each groupable field is a NOT NULL text column, or the scope). */
const groupValue = parsed(
  z.string(),
  "deploy-site-messages.inbox:groups.value",
);

/** Each groupable field over one deployment's copy (its scope is a constant). */
function groupTarget(
  deploymentId: string,
  groupBy: GroupQuery["groupBy"],
): SQL {
  switch (groupBy) {
    case "deploymentId":
      return sql`${deploymentId}::text`;
    case "replyTo":
      return sql`${siteMessages.replyTo}`;
    case "message":
      return sql`${siteMessages.message}`;
    case "verdict":
      return sql`${siteMessages.verdict}`;
    case "notifyState":
      return sql`${siteMessages.notifyState}`;
    case "createdAt":
      throw new Error(
        "deploy-site-messages.inbox: createdAt groups through its own decoder (readInboxGroups)",
      );
  }
}

/** What a read runs on: a replica snapshot's transaction, or (in a test) a database. */
type Reader = Pick<NodePgDatabase, "select">;

/** One window of a deployment's messages: `where`, in `createdAt` order (the id breaking ties), inside `(after, until]`. */
export async function readInboxWindow(
  tx: Reader,
  deploymentId: string,
  q: WindowQuery,
): Promise<SiteMessageRow[]> {
  const dir = directionOf(q);
  const rows = await tx
    .select(COLUMNS)
    .from(siteMessages)
    .where(
      and(
        whereSql(deploymentId, q.where),
        q.after === undefined ? undefined : afterSql(q.after, dir),
        q.until === undefined ? undefined : untilSql(q.until, dir),
      ),
    )
    .orderBy(
      dir === "desc" ? desc(createdAtMs) : asc(createdAtMs),
      sql`${siteMessages.id} COLLATE "C" ASC`,
    )
    .limit(q.limit);
  return rows.map((r) => toRow(deploymentId, r));
}

/** A deployment's messages by the intake's ids (absent ones left out). */
export async function readInboxRows(
  tx: Reader,
  deploymentId: string,
  messageIds: readonly string[],
): Promise<SiteMessageRow[]> {
  const rows = await tx
    .select(COLUMNS)
    .from(siteMessages)
    .where(
      inArray(
        siteMessages.id,
        messageIds.map((id) => siteMessageIdKind.key(id)),
      ),
    );
  return rows.map((r) => toRow(deploymentId, r));
}

/** A deployment's messages grouped by one field: count desc, then value. */
export function readInboxGroups(
  tx: Reader,
  deploymentId: string,
  q: GroupQuery,
): Promise<{ value: string; count: number }[]> {
  if (q.groupBy === "createdAt") {
    // One group per instant, cut to ms as the row's `createdAt` holds it,
    // valued as its ISO text (`Date#toISOString()`, the `$key` spelling).
    return tx
      .select({
        value:
          sql`to_char(${createdAtMs} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.mapWith(
            groupValue,
          ),
        count: count(),
      })
      .from(siteMessages)
      .where(whereSql(deploymentId, q.where))
      .groupBy(createdAtMs)
      .orderBy(desc(count()), sql`1 NULLS LAST`)
      .limit(q.limit);
  }
  const target = groupTarget(deploymentId, q.groupBy);
  return tx
    .select({ value: target.mapWith(groupValue), count: count() })
    .from(siteMessages)
    .where(whereSql(deploymentId, q.where))
    .groupBy(target)
    .orderBy(desc(count()), sql`1 NULLS LAST`)
    .limit(q.limit);
}

/** How many of a deployment's messages match `where`. */
export async function readInboxCount(
  tx: Reader,
  deploymentId: string,
  where: Filter | undefined,
): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(siteMessages)
    .where(whereSql(deploymentId, where));
  return row!.count;
}

/** `:rows` ids grouped by the deployment whose copy holds them. */
export function messageIdsByDeployment(
  ids: readonly string[],
): Map<string, string[]> {
  const byDeployment = new Map<string, string[]>();
  for (const id of ids) {
    const { deploymentId, messageId } = parseSiteMessageRowId(id);
    byDeployment.set(deploymentId, [
      ...(byDeployment.get(deploymentId) ?? []),
      messageId,
    ]);
  }
  return byDeployment;
}
