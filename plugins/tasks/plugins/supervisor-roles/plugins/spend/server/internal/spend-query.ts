import { z } from "zod";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  SPEND_SOURCE_PREFIX,
  UNATTRIBUTED_SPEND_SOURCE,
} from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/core";
import { _claudeSpendHours } from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/server";
import {
  _attempts,
  _conversations,
  _tasks,
  tasksMandate,
} from "@plugins/tasks/plugins/tasks-core/server";
import { tasksOrigin } from "@plugins/tasks/plugins/automations/server";
import {
  _supervisorRoles,
  tasksSupervisor,
} from "@plugins/tasks/plugins/supervisor-roles/server";
import { supervisorRoleMandate } from "@plugins/tasks/plugins/supervisor-roles/core";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import type { SpendBreakdown, SpendWindow } from "../../core";
import { buildSpendTree, type SpendSourceRow } from "./tree";

/** Every relation the read joins, besides the ledger itself. */
export const SPEND_JOINED_RELATIONS = [
  _conversations,
  _attempts,
  _tasks,
  tasksMandate.table,
  tasksSupervisor.table,
  _supervisorRoles,
  tasksOrigin.table,
];

const MANDATES = {
  roleSession: supervisorRoleMandate.id,
  adhoc: supervisorMandate.id,
};

const SourceRowSchema = z.object({
  source: z.string(),
  cost_usd: z.number(),
  billed_usd: z.number(),
  conv_id: z.string().nullable(),
  conv_title: z.string().nullable(),
  conv_live: z.boolean().nullable(),
  attempt_id: z.string().nullable(),
  attempt_number: z.number().int().nullable(),
  task_id: z.string().nullable(),
  task_title: z.string().nullable(),
  mandate_id: z.string().nullable(),
  root_id: z.string().nullable(),
  root_title: z.string().nullable(),
  role_id: z.string().nullable(),
  role_name: z.string().nullable(),
  session_number: z.number().int().nullable(),
  automation_id: z.string().nullable(),
});
type SourceRowRaw = z.infer<typeof SourceRowSchema>;

const FirstRowSchema = z.object({ first: z.string().nullable() });

/** A raw joined row, as the tree builder reads it. */
function sourceRow(r: SourceRowRaw): SpendSourceRow {
  const cli = r.source.startsWith(SPEND_SOURCE_PREFIX.cli)
    ? r.source.slice(SPEND_SOURCE_PREFIX.cli.length)
    : null;
  return {
    source: r.source,
    costUsd: r.cost_usd,
    billedUsd: r.billed_usd,
    caller: cli,
    conversation:
      r.conv_id === null
        ? null
        : { id: r.conv_id, title: r.conv_title, live: r.conv_live === true },
    attempt:
      r.attempt_id === null || r.attempt_number === null
        ? null
        : { id: r.attempt_id, number: r.attempt_number },
    task:
      r.task_id === null ? null : { id: r.task_id, title: r.task_title ?? "" },
    mandateId: r.mandate_id,
    root:
      r.root_id === null ? null : { id: r.root_id, title: r.root_title ?? "" },
    role:
      r.role_id === null || r.role_name === null || r.session_number === null
        ? null
        : { id: r.role_id, name: r.role_name, session: r.session_number },
    automationId: r.automation_id,
  };
}

/**
 * Each source's spend over the windows (every account from its own `since`;
 * the `unattributed` history left out), joined to what spent it: a `conv:`
 * source's conversation → attempt → task → the task's effective mandate and
 * the root stating it → the root's owning role and filing automation.
 */
export async function readSpendSources(
  exec: DbExecutor,
  windows: readonly SpendWindow[],
): Promise<SpendSourceRow[]> {
  if (windows.length === 0) return [];
  const h = _claudeSpendHours;
  const conv = SPEND_SOURCE_PREFIX.conversation;
  const rows = await executeRows(exec, {
    label: "supervisors spend sources",
    query: sql`
      WITH w AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb)
          AS w("accountId" text, "since" timestamptz, "metered" boolean)
      ), spend AS (
        SELECT h.source,
               sum(h.cost_usd)::float8 AS cost_usd,
               coalesce(sum(h.cost_usd) FILTER (WHERE w.metered), 0)::float8 AS billed_usd
          FROM ${h} h
          JOIN w ON w."accountId" = h.account_id AND h.hour >= w.since
         WHERE h.source <> ${UNATTRIBUTED_SPEND_SOURCE}
         GROUP BY h.source
      )
      SELECT s.source, s.cost_usd, s.billed_usd,
             c.id AS conv_id, c.title AS conv_title,
             CASE WHEN c.id IS NULL THEN NULL ELSE c.ended_at IS NULL END AS conv_live,
             a.id AS attempt_id,
             CASE WHEN a.id IS NULL THEN NULL ELSE (
               SELECT count(*)::int FROM ${_attempts} a2
                WHERE a2.task_id = a.task_id
                  AND (a2.created_at, a2.id) <= (a.created_at, a.id)
             ) END AS attempt_number,
             t.id AS task_id, t.title AS task_title,
             m.mandate_id, r.id AS root_id, r.title AS root_title,
             sr.id AS role_id, sr.name AS role_name,
             CASE WHEN sr.id IS NULL THEN NULL ELSE (
               SELECT count(*)::int
                 FROM ${tasksSupervisor.table} s2
                 JOIN ${tasksMandate.table} m2
                   ON m2.parent_id = s2.parent_id
                  AND m2.source_task_id = s2.parent_id
                  AND m2.mandate_id = ${MANDATES.roleSession}
                 JOIN ${_tasks} r2 ON r2.id = s2.parent_id
                WHERE s2.supervisor = sr.id
                  AND (r2.created_at, r2.id) <= (r.created_at, r.id)
             ) END AS session_number,
             o.automation_id
        FROM spend s
        LEFT JOIN ${_conversations} c
          ON s.source LIKE ${`${conv}%`}
         AND c.id = substr(s.source, ${conv.length + 1})
        LEFT JOIN ${_attempts} a ON a.id = c.attempt_id
        LEFT JOIN ${_tasks} t ON t.id = a.task_id
        LEFT JOIN ${tasksMandate.table} m ON m.parent_id = t.id
        LEFT JOIN ${_tasks} r ON r.id = m.source_task_id
        LEFT JOIN ${tasksSupervisor.table} sup ON sup.parent_id = r.id
        LEFT JOIN ${_supervisorRoles} sr ON sr.id = sup.supervisor
        LEFT JOIN ${tasksOrigin.table} o ON o.parent_id = r.id`,
    row: SourceRowSchema,
  });
  return rows.map(sourceRow);
}

/** The first attributed hour on any of `accountIds`, or `null`. */
async function readAttributedSince(
  exec: DbExecutor,
  accountIds: readonly string[],
): Promise<string | null> {
  if (accountIds.length === 0) return null;
  const h = _claudeSpendHours;
  const [row] = await executeRows(exec, {
    label: "supervisors spend attributed since",
    query: sql`
      SELECT to_char(min(h.hour) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first
        FROM ${h} h
       WHERE h.account_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb))
         AND h.source <> ${UNATTRIBUTED_SPEND_SOURCE}`,
    row: FirstRowSchema,
  });
  return row?.first ?? null;
}

/** The breakdown for `windows`: the drill tree and where attribution starts. */
export async function readSpendBreakdown(
  exec: DbExecutor,
  windows: readonly SpendWindow[],
): Promise<SpendBreakdown> {
  const [sources, attributedSince] = await Promise.all([
    readSpendSources(exec, windows),
    readAttributedSince(
      exec,
      windows.map((w) => w.accountId),
    ),
  ]);
  return { tree: buildSpendTree(sources, MANDATES), attributedSince };
}
