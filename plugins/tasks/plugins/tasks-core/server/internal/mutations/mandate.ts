import { sql, type SQL } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _tasks } from "../tables";
import { tasksMandate } from "../tables-mandate";
import type { DbExecutor } from "../status-batch";

/**
 * Re-derive `tasks_ext_mandate` for the subtrees rooted at `taskIds` (each
 * task and everything filed under it): a task's effective mandate is its own
 * `mandate_ref`, else its nearest ancestor's. Writes only rows that change, so
 * a refresh that moves nothing sends no row diff. Called on the caller's
 * executor by every write that can move it — create, re-file, a mandate
 * stated or cleared — so the materialization commits with the write.
 */
export async function refreshEffectiveMandates(
  taskIds: readonly string[],
  exec: DbExecutor = db,
): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return;
  await writeEffective(
    sql`SELECT t.id FROM ${_tasks} t WHERE t.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`,
    exec,
  );
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

/** `starts`: a query selecting `id` — the tops of the subtrees to write. Each
 * top's effective mandate is read up its chain, then carried down. */
async function writeEffective(starts: SQL, exec: DbExecutor): Promise<void> {
  const ext = tasksMandate.table;
  await exec.execute(sql`
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
        SELECT DISTINCT ON (start_id) start_id AS id, mandate_ref AS eff
          FROM up
         WHERE mandate_ref IS NOT NULL
         ORDER BY start_id, depth
      ),
      down(id, eff) AS (
        SELECT id, eff FROM top
        UNION ALL
        SELECT c.id, COALESCE(c.mandate_ref, d.eff)
          FROM ${_tasks} c JOIN down d ON c.folder_id = d.id
      )
    INSERT INTO ${ext} (parent_id, mandate_id)
    SELECT DISTINCT ON (id) id, eff FROM down
    ON CONFLICT (parent_id) DO UPDATE
       SET mandate_id = EXCLUDED.mandate_id
     WHERE ${ext}.mandate_id IS DISTINCT FROM EXCLUDED.mandate_id
  `);
}
