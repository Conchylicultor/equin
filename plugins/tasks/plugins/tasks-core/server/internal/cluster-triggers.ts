import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { TASK_CLUSTER_MAX } from "../../core";

// ── The cluster invariant, kept by the database ─────────────────────────────
//
// `tasks.cluster_id` is the monotone union-find label
// (`research/2026-08-03-tasks-monotone-deps-tree-membership.md`): every
// dependency, folder and group edge stays inside one cluster, so a reader
// walking a task's edges needs that cluster's rows and no other
// (`taskClusterRows`). Two halves keep it, both in the database, so no writer —
// a mutation that forgets, a seed, a hand-written UPDATE, a backend still
// running older code — can commit an edge that leaves a cluster:
//
//  1. **The edge write IS the union.** AFTER triggers on the three edge kinds
//     (`task_dependencies`, `tasks.folder_id`, `tasks.group_id`) call
//     `tasks_union_clusters`, in the writing transaction: an edge and its union
//     commit or roll back together, and the app code never calls a union.
//  2. **No label write leaves a crossing edge.** An AFTER UPDATE OF cluster_id
//     trigger re-reads every edge of each relabelled task at the end of the
//     statement and refuses it if one crosses a cluster — what a direct
//     `UPDATE tasks SET cluster_id` would do (the union's own relabel moves a
//     whole cluster in one statement, so it always passes). Immediate, not
//     DEFERRED: the change feed refuses deferred triggers on a table it routes
//     (their writes would notify after the transaction's end marker), and with
//     every edge write unioning in its own statement there is no in-between
//     state for a deferral to wait out.
//
// And the size bound: a union that would build a cluster over
// TASK_CLUSTER_MAX tasks is refused, loudly, in the write that asked for it —
// clusters only grow by union, so no cluster can exceed it and
// `taskClusterRows` declares it as its checked `max`.
//
// Survives a dump/restore fork: pg_dump puts triggers in post-data, so the
// copied rows load before they exist and keep their labels.

const LOCK_NAMESPACE = "tasks.cluster";

const UNION_FN = `CREATE OR REPLACE FUNCTION tasks_union_clusters(a text, b text)
  RETURNS void
  LANGUAGE plpgsql
  AS $$
-- Merge the clusters of tasks a and b, keeping min(label) — associative and
-- idempotent, so the incremental union and a batch backfill agree, and a
-- no-op when the two already share a cluster.
--
-- Locks the two LABELS (transaction advisory locks, in one order), not the two
-- endpoint rows: two unions that touch one cluster through different endpoints
-- (union(X1, Y) and union(X2, Z), X1 and X2 both in X) must serialize, or the
-- second relabels X's rows from a snapshot that cannot see the Y rows the first
-- just moved into X, stranding them. Every writer of a label holds its lock, so
-- once both are held and both endpoints still carry them, the two clusters
-- cannot change under us (labels are re-read: each statement here sees what
-- committed before it).
DECLARE
  la text;
  lb text;
  merged bigint;
BEGIN
  IF a = b THEN
    RETURN;
  END IF;
  LOOP
    SELECT cluster_id INTO la FROM tasks WHERE id = a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tasks_union_clusters: task % not found', a;
    END IF;
    SELECT cluster_id INTO lb FROM tasks WHERE id = b;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tasks_union_clusters: task % not found', b;
    END IF;
    IF la = lb THEN
      RETURN;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('${LOCK_NAMESPACE}'), hashtext(least(la, lb)));
    PERFORM pg_advisory_xact_lock(hashtext('${LOCK_NAMESPACE}'), hashtext(greatest(la, lb)));
    EXIT WHEN (SELECT cluster_id FROM tasks WHERE id = a) = la
          AND (SELECT cluster_id FROM tasks WHERE id = b) = lb;
  END LOOP;
  SELECT count(*) INTO merged FROM tasks WHERE cluster_id IN (la, lb);
  IF merged > ${TASK_CLUSTER_MAX} THEN
    RAISE EXCEPTION 'Linking task % to task % would merge two dependency clusters into % tasks, over the declared maximum of ${TASK_CLUSTER_MAX}', a, b, merged
      USING ERRCODE = 'check_violation',
            HINT = 'Clusters only grow (tasks.cluster_id is monotone), and every dependency surface reads one whole. A cluster this big means something files under or depends on one long-lived task without end — file those tasks elsewhere (a category, not a folder), or raise TASK_CLUSTER_MAX (tasks-core/core) with the reason.';
  END IF;
  UPDATE tasks SET cluster_id = least(la, lb) WHERE cluster_id = greatest(la, lb);
END;
$$`;

const ON_DEPENDENCY_FN = `CREATE OR REPLACE FUNCTION tasks_cluster_on_dependency()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM tasks_union_clusters(NEW.task_id, NEW.depends_on_task_id);
  RETURN NULL;
END;
$$`;

const ON_TASK_EDGE_FN = `CREATE OR REPLACE FUNCTION tasks_cluster_on_task_edge()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    PERFORM tasks_union_clusters(NEW.id, NEW.folder_id);
  END IF;
  IF NEW.group_id IS NOT NULL THEN
    PERFORM tasks_union_clusters(NEW.id, NEW.group_id);
  END IF;
  RETURN NULL;
END;
$$`;

// At the end of the statement that moved a label: the union's own relabel
// (every loser row moved, so each edge lands on the winner) or a direct write.
// Re-reads the row — NEW is the row as written.
const CHECK_TASK_FN = `CREATE OR REPLACE FUNCTION tasks_cluster_check_relabel()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  label text;
  other text;
BEGIN
  SELECT cluster_id INTO label FROM tasks WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT n.id INTO other
    FROM (
      SELECT folder_id AS id FROM tasks WHERE id = NEW.id
      UNION ALL SELECT group_id FROM tasks WHERE id = NEW.id
      UNION ALL SELECT id FROM tasks WHERE folder_id = NEW.id
      UNION ALL SELECT id FROM tasks WHERE group_id = NEW.id
      UNION ALL SELECT depends_on_task_id FROM task_dependencies WHERE task_id = NEW.id
      UNION ALL SELECT task_id FROM task_dependencies WHERE depends_on_task_id = NEW.id
    ) n
    JOIN tasks t ON t.id = n.id
   WHERE t.cluster_id <> label
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Task % (cluster %) has an edge to task % in another cluster — every dependency, folder and group edge must stay inside one cluster', NEW.id, label, other
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$`;

export const taskClusterTriggers = defineDbTriggers({
  id: "tasks.cluster",
  functions: [
    { name: "tasks_union_clusters", args: "text, text", ddl: UNION_FN },
    { name: "tasks_cluster_on_dependency", args: "", ddl: ON_DEPENDENCY_FN },
    { name: "tasks_cluster_on_task_edge", args: "", ddl: ON_TASK_EDGE_FN },
    { name: "tasks_cluster_check_relabel", args: "", ddl: CHECK_TASK_FN },
  ],
  triggers: [
    {
      name: "tasks_cluster_on_dependency",
      table: "task_dependencies",
      ddl: `CREATE OR REPLACE TRIGGER tasks_cluster_on_dependency
  AFTER INSERT OR UPDATE OF task_id, depends_on_task_id ON task_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION tasks_cluster_on_dependency()`,
    },
    {
      name: "tasks_cluster_on_task_edge",
      table: "tasks",
      ddl: `CREATE OR REPLACE TRIGGER tasks_cluster_on_task_edge
  AFTER INSERT OR UPDATE OF folder_id, group_id ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_cluster_on_task_edge()`,
    },
    {
      name: "tasks_cluster_check_relabel",
      table: "tasks",
      ddl: `CREATE OR REPLACE TRIGGER tasks_cluster_check_relabel
  AFTER UPDATE OF cluster_id ON tasks
  FOR EACH ROW
  WHEN (OLD.cluster_id IS DISTINCT FROM NEW.cluster_id)
  EXECUTE FUNCTION tasks_cluster_check_relabel()`,
    },
  ],
});
