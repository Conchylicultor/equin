import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { taskMandateChanged } from "../tables-events";
import { _tasks } from "../tables";
import { tasksMandate } from "../tables-mandate";
import type { DbExecutor } from "../status-batch";

/**
 * Re-derive `tasks_ext_mandate` for the subtrees rooted at `taskIds` (each
 * task and everything filed under it): a task's effective mandate is its own
 * `mandate_ref`, else its nearest ancestor's. Writes only rows that change, so
 * a refresh that moves nothing sends no row diff. Called on the caller's
 * executor by every write that can move it — create, re-file, a mandate
 * stated or cleared — so the materialization commits with the write — and
 * announces the existing tasks it moved (`tasks.mandateChanged`) in it.
 */
export async function refreshEffectiveMandates(
  taskIds: readonly string[],
  exec: DbExecutor = db,
): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return;
  const moved = await writeEffective(
    sql`SELECT t.id FROM ${_tasks} t WHERE t.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`,
    exec,
  );
  if (moved.length > 0) {
    await taskMandateChanged.emit(
      { taskIds: moved },
      exec === db ? undefined : { tx: exec as EmitTx },
    );
  }
}

/** Re-derive every task's effective mandate — the startup backstop. */
export async function reconcileEffectiveMandates(
  exec: DbExecutor = db,
): Promise<void> {
  await writeEffective(
    sql`SELECT t.id FROM ${_tasks} t WHERE t.folder_id IS NULL`,
    exec,
  );
}

const MovedRowSchema = z.object({ id: z.string(), inserted: z.boolean() });

/** `starts`: a query selecting `id` — the tops of the subtrees to write. Each
 * top's effective mandate (and the task stating it) is read up its chain,
 * then carried down. */
async function writeEffective(
  starts: SQL,
  exec: DbExecutor,
): Promise<string[]> {
  const ext = tasksMandate.table;
  const rows = await executeRows(exec, {
    label: "writeEffective",
    row: MovedRowSchema,
    // sql-writes:hand-written — WITH RECURSIVE walk up the folder tree feeding the write
    query: sql`
    WITH RECURSIVE
      start AS (${starts}),
      up(start_id, id, folder_id, mandate_ref, depth) AS (
        SELECT s.id, t.id, t.folder_id, t.mandate_ref, 0
          FROM start s JOIN ${_tasks} t ON t.id = s.id
        UNION ALL
        SELECT u.start_id, p.id, p.folder_id, p.mandate_ref, u.depth + 1
          FROM ${_tasks} p JOIN up u ON p.id = u.folder_id
         WHERE u.mandate_ref IS NULL
      ),
      top AS (
        SELECT DISTINCT ON (start_id) start_id AS id, mandate_ref AS eff,
               up.id AS src
          FROM up
         WHERE mandate_ref IS NOT NULL
         ORDER BY start_id, depth
      ),
      down(id, eff, src) AS (
        SELECT id, eff, src FROM top
        UNION ALL
        SELECT c.id,
               COALESCE(c.mandate_ref, d.eff),
               CASE WHEN c.mandate_ref IS NULL THEN d.src ELSE c.id END
          FROM ${_tasks} c JOIN down d ON c.folder_id = d.id
      )
    INSERT INTO ${ext} (parent_id, mandate_id, source_task_id)
    SELECT DISTINCT ON (id) id, eff, src FROM down
    ON CONFLICT (parent_id) DO UPDATE
       SET mandate_id = EXCLUDED.mandate_id,
           source_task_id = EXCLUDED.source_task_id
     WHERE (${ext}.mandate_id, ${ext}.source_task_id)
           IS DISTINCT FROM (EXCLUDED.mandate_id, EXCLUDED.source_task_id)
    RETURNING parent_id AS id, (xmax = 0) AS inserted
  `,
  });
  // The existing tasks it moved: a row it inserted is a task just created,
  // which no agent runs on yet.
  return rows.filter((r) => !r.inserted).map((r) => r.id);
}
