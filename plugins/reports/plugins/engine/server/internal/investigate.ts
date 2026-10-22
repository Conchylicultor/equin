import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { ProducerExecutor } from "@plugins/database/plugins/change-feed/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  _reports,
  reportInvestigationSink,
  ReportKind,
} from "@plugins/reports/server";
import { reportsProducer } from "./producer";
import { reportIdKind } from "@plugins/reports/core";

// Appended to every report-filed task. The agent that picks one up is about to
// debug, so point them at the debugging map first — it routes them to the right
// surface (durable slow-op store, runtime profiler, pg_stat_activity) instead of
// guessing.
const DEBUG_SKILL_HINT =
  "> Before debugging, read the `debug` skill (`.claude/skills/debug/SKILL.md`) — the map of logs, profiling, slow-ops, crashes, and DB surfaces.";

// Per-reportId in-process mutex. Serialising at the JS layer avoids DB row locks
// saturating the connection pool, and lets a second concurrent caller observe
// the task already linked instead of racing to create a duplicate.
const taskCreationLocks = new Map<string, Promise<void>>();

// On-demand investigation: the ONLY place that now turns a report into a task.
// The task-creating handler is registered softly by the tasks domain into
// `reportInvestigationSink` — a composition without tasks has no handler, so
// emit() returns undefined and this throws loudly. Idempotency (a report already
// linked to a live task) is enforced by the registered handler.
export async function investigateReport(
  reportId: string,
): Promise<{ taskId: string }> {
  // Serialize concurrent callers for the same report. A request arriving while
  // another is mid-creation waits on the prior promise, then re-reads the row
  // and observes the task already linked.
  while (taskCreationLocks.has(reportId)) {
    await taskCreationLocks.get(reportId);
  }
  let release!: () => void;
  const inflight = new Promise<void>((r) => (release = r));
  taskCreationLocks.set(reportId, inflight);

  try {
    // The task-creation DB work (select + the handler's getTask/createTask) is
    // part of the observability subsystem's own I/O — suppress its spans so they
    // never re-feed the slow-op recorder. The suppression ALS propagates through
    // every awaited query, including across the awaited sink emit into the
    // handler's cross-plugin getTask/createTask DB calls.
    //
    // The enclosing runInBackgroundLane declares the same I/O background for the
    // DB gate. It fans out into another plugin's writes (createTask), so under
    // origin-based gating it would otherwise charge the caller's origin — an
    // `http` handler — against the reserved-interactive floor. Filing an
    // investigation task is bookkeeping about an incident, never the incident's
    // critical path. See
    // research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.
    return await runInBackgroundLane(() =>
      runWithoutProfiling(async () => {
        const [row] = await db
          .select()
          .from(_reports)
          .where(eq(_reports.id, reportIdKind.key(reportId)))
          .limit(1);
        if (!row) {
          throw new Error(
            `investigateReport: no report found for id "${reportId}"`,
          );
        }

        const spec = ReportKind.getContributions().find(
          (k) => k.kind === row.kind,
        );
        if (!spec) {
          // A persisted report whose kind has no registered spec is a wiring bug,
          // not a runtime condition to paper over.
          throw new Error(
            `investigateReport: no ReportKind registered for kind "${row.kind}"`,
          );
        }

        const { title, description } = spec.renderTask(row);
        const result = await reportInvestigationSink.emit({
          existingTaskId: row.taskId,
          title,
          description: `${description}\n\n${DEBUG_SKILL_HINT}`,
          author: "reports-plugin",
        });
        if (!result) {
          throw new Error(
            "investigateReport: no investigation-task handler registered (tasks capability absent in this composition)",
          );
        }
        if (result.taskId !== row.taskId) {
          await linkReportTask(db, row.id, result.taskId);
        }
        return { taskId: result.taskId };
      }),
    );
  } finally {
    taskCreationLocks.delete(reportId);
    release();
  }
}

/**
 * Link `reportId` to its investigation task — the one write Investigate makes.
 * `interactive`: the person who clicked Investigate is waiting on the detail
 * pane's "View task" — stated here, since `investigateReport` runs in the
 * background lane and its origin says nothing about who waits. Its flush
 * routes the id at once (in the producer's root context, so the caller's
 * suppression scope does not hide it) instead of after the 2 s window.
 * Exported for the reports.list oracle, which runs it against a throwaway
 * database.
 */
export async function linkReportTask(
  executor: ProducerExecutor,
  reportId: string,
  taskId: string,
): Promise<void> {
  await reportsProducer.mutate(
    executor,
    (q, t) =>
      q
        .update(t)
        .set({ taskId })
        .where(eq(t.id, reportIdKind.key(reportId))),
    { latency: "interactive" },
  );
}
