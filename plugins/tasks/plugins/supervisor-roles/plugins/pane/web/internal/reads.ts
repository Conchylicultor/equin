import { useMemo } from "react";
import { exposedColumns } from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  taskMandateShape,
  taskWindow,
  type TaskTreeRow,
} from "@plugins/tasks/plugins/tasks-core/core";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import {
  BACKLOG_STATUSES,
  ENDED_SESSION_STATUSES,
  roleBacklogWhere,
  roleSessionsWhere,
  supervisorRoleMandate,
  supervisorRoles,
  taskSupervisorShape,
  type SupervisorRole,
} from "@plugins/tasks/plugins/supervisor-roles/core";

// Every read of the Supervisors pane is a bounded read of the tasks tree
// (`taskWindow`) through the ONE definition of a backlog and a session
// (`roleBacklogWhere` / `roleSessionsWhere`, supervisor-roles core), so the
// pane and the server's backlog tool / one-live-session rule cannot disagree.

/** The supervisor field (`tasks_ext_supervisor.supervisor`) as a column set. */
export const supervisorColumns = exposedColumns(taskSupervisorShape.exposure);
/** The effective mandate (`tasks_ext_mandate.mandateId`) as a column set. */
export const mandateColumns = exposedColumns(taskMandateShape.exposure);
const COLUMNS = [supervisorColumns, mandateColumns] as const;

/** The most sessions a role's history shows (newest first). */
export const SESSIONS_SHOWN = 50;
/** The most backlog rows the pane reads at once (oldest first). */
export const BACKLOG_SHOWN = 200;
/** The most ad-hoc supervisors listed — live ones only, a handful. */
const ADHOC_SHOWN = 50;

/** The role a task row belongs to (its exposed `supervisor`), or `null`. */
export function roleOfRow(row: TaskTreeRow): string | null {
  return supervisorColumns.read(row).supervisor ?? null;
}

/** What waits in one role's backlog. */
export interface BacklogSummary {
  count: number;
  /** When its oldest task was filed. */
  oldest: Date;
}

/** The most backlog tasks counted across every role (a bounded window). */
const BACKLOGS_COUNTED = 500;

/**
 * What waits in each role's backlog — ONE bounded window over every role's
 * backlog roots, oldest first, folded by owner. A window, not a grouping: a
 * window is routed row by row (a task write reaches it only when the task is,
 * or becomes, a backlog task), where a grouping recomputes and re-pushes on
 * every write to the tasks tables — and the sidebar holds this read on every
 * page. A role with nothing waiting is absent from the map; `capped` when
 * more than {@link BACKLOGS_COUNTED} tasks wait in all (the counts are then
 * floors).
 */
export function useBacklogCounts(): ResourceResult<{
  byRole: ReadonlyMap<string, BacklogSummary>;
  capped: boolean;
}> {
  const rows = useLive(taskWindow, {
    columns: [...COLUMNS],
    where: {
      folderId: { isEmpty: true },
      "tasks_ext_supervisor.supervisor": { isNotEmpty: true },
      "tasks_ext_mandate.mandateId": { ne: supervisorRoleMandate.id },
      status: { in: [...BACKLOG_STATUSES] },
    },
    orderBy: [["createdAt", "asc"]],
    limit: BACKLOGS_COUNTED,
  });
  return useMemo(
    () =>
      mapResource(rows, (rs) => {
        const byRole = new Map<string, BacklogSummary>();
        for (const r of rs) {
          const role = roleOfRow(r);
          if (role === null) continue;
          const known = byRole.get(role);
          if (known) known.count += 1;
          else byRole.set(role, { count: 1, oldest: new Date(r.createdAt) });
        }
        return {
          byRole,
          capped: rows.status === "ready" && rows.canGrow,
        };
      }),
    [rows],
  );
}

/**
 * Every LIVE role session root (any role), newest first — at most one per
 * role (the launch endpoint's rule), so one small window.
 */
export function useLiveRoleSessions(): ResourceResult<
  ReadonlyMap<string, TaskTreeRow>
> {
  const rows = useLive(taskWindow, {
    columns: [...COLUMNS],
    where: {
      folderId: { isEmpty: true },
      "tasks_ext_mandate.mandateId": supervisorRoleMandate.id,
      status: { notIn: [...ENDED_SESSION_STATUSES] },
    },
    orderBy: [["createdAt", "desc"]],
    limit: 100,
  });
  return useMemo(
    () =>
      mapResource(rows, (rs) => {
        const byRole = new Map<string, TaskTreeRow>();
        for (const r of rs) {
          const role = roleOfRow(r);
          if (role !== null && !byRole.has(role)) byRole.set(role, r);
        }
        return byRole;
      }),
    [rows],
  );
}

/**
 * The ad-hoc supervisors running now: root tasks stating the plain
 * supervisor mandate (the Supervisor launch option) whose agent is at work —
 * no backlog, gone with their session.
 */
export function useAdhocSupervisors(): ResourceResult<readonly TaskTreeRow[]> {
  return useLive(taskWindow, {
    columns: [mandateColumns],
    where: {
      folderId: { isEmpty: true },
      "tasks_ext_mandate.mandateId": supervisorMandate.id,
      status: { in: ["in_progress", "in_progress_blocked", "need_action"] },
    },
    orderBy: [["createdAt", "desc"]],
    limit: ADHOC_SHOWN,
  });
}

/** One role's backlog, oldest first. */
export function useRoleBacklog(roleId: string) {
  return useLive(taskWindow, {
    columns: [...COLUMNS],
    where: roleBacklogWhere(roleId),
    orderBy: [["createdAt", "asc"]],
    limit: BACKLOG_SHOWN,
  });
}

/** One role's sessions, newest first. */
export function useRoleSessions(roleId: string) {
  return useLive(taskWindow, {
    columns: [...COLUMNS],
    where: roleSessionsWhere(roleId),
    orderBy: [["createdAt", "desc"]],
    limit: SESSIONS_SHOWN,
  });
}

/** Every role, by name (the whole set). */
export function useRoles(): ResourceResult<readonly SupervisorRole[]> {
  return useLive(supervisorRoles);
}

/**
 * The sidebar's summary: live supervisor sessions (role sessions + ad-hoc)
 * and the tasks waiting in every backlog.
 */
export function useSupervisorsSummary(): ResourceResult<{
  live: number;
  waiting: number;
}> {
  const counts = useBacklogCounts();
  const sessions = useLiveRoleSessions();
  const adhoc = useAdhocSupervisors();
  return useMemo(
    () =>
      mapResource(combineResources({ counts, sessions, adhoc }), (d) => ({
        live: d.sessions.size + d.adhoc.length,
        waiting: [...d.counts.byRole.values()].reduce((n, c) => n + c.count, 0),
      })),
    [counts, sessions, adhoc],
  );
}

/** What a session's tree came to: its tasks done, at work, dropped. */
export interface SessionTally {
  done: number;
  running: number;
  dropped: number;
}

const RUNNING_STATUSES = [
  "in_progress",
  "in_progress_blocked",
  "need_action",
] as const;

/**
 * Each session's tally: the tasks whose effective mandate comes from its
 * root (the exposed `mandateSource` — however deep they were filed), counted
 * by THREE groupings over every listed session at once (done, running,
 * dropped — grouped by root), never the trees' rows, and never one read per
 * session. A root counts in its own tree; it is taken back out of its own
 * status's count. At least one session (an empty `in` reads nothing to
 * group); `sessions` must keep its identity between renders (a live
 * read's own array, or a memoized one).
 */
export function useSessionTallies(
  sessions: readonly Pick<TaskTreeRow, "id" | "status">[],
): ResourceResult<ReadonlyMap<string, SessionTally>> {
  const ids = sessions.map((s) => s.id);
  const done = useLive(taskWindow, {
    columns: [mandateColumns],
    groupBy: "tasks_ext_mandate.sourceTaskId",
    where: { "tasks_ext_mandate.sourceTaskId": { in: ids }, status: "done" },
    limit: 100,
  });
  const dropped = useLive(taskWindow, {
    columns: [mandateColumns],
    groupBy: "tasks_ext_mandate.sourceTaskId",
    where: {
      "tasks_ext_mandate.sourceTaskId": { in: ids },
      status: "dropped",
    },
    limit: 100,
  });
  const running = useLive(taskWindow, {
    columns: [mandateColumns],
    groupBy: "tasks_ext_mandate.sourceTaskId",
    where: {
      "tasks_ext_mandate.sourceTaskId": { in: ids },
      status: { in: [...RUNNING_STATUSES] },
    },
    limit: 100,
  });
  return useMemo(
    () =>
      mapResource(combineResources({ done, dropped, running }), (d) => {
        const by = (gs: readonly { value: unknown; count: number }[]) =>
          new Map(gs.map((g) => [String(g.value), g.count]));
        const doneBy = by(d.done);
        const droppedBy = by(d.dropped);
        const runningBy = by(d.running);
        const isRunning = (st: string) =>
          (RUNNING_STATUSES as readonly string[]).includes(st);
        return new Map(
          sessions.map((s) => [
            s.id,
            {
              done: (doneBy.get(s.id) ?? 0) - (s.status === "done" ? 1 : 0),
              dropped:
                (droppedBy.get(s.id) ?? 0) - (s.status === "dropped" ? 1 : 0),
              running:
                (runningBy.get(s.id) ?? 0) - (isRunning(s.status) ? 1 : 0),
            },
          ]),
        );
      }),
    // `sessions` must be stable across renders (a live read's array).
    [done, dropped, running, sessions],
  );
}
