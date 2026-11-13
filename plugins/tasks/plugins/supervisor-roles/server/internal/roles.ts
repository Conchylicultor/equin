import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  _tasks,
  createTask,
  setMandate,
  tasksView,
} from "@plugins/tasks/plugins/tasks-core/server";
import type { TaskStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";
import { setTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import { conversationMandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  BACKLOG_STATUSES,
  ENDED_SESSION_STATUSES,
  supervisorRoleIdKind,
  supervisorRoleMandate,
  type SupervisorRole,
} from "../../core";
import {
  _supervisorRoles,
  supervisorRolesEntity,
  tasksSupervisor,
} from "./tables";

/** What `add_task`'s `supervisor` names: a listed role's id, or the fallback. */
export const FALLBACK_ROLE_REF = "fallback";

const parseRole = (row: unknown): SupervisorRole =>
  supervisorRolesEntity.schema.parse(row);

export async function listSupervisorRoles(
  exec: DbExecutor = db,
): Promise<SupervisorRole[]> {
  const rows = await exec
    .select()
    .from(_supervisorRoles)
    .orderBy(asc(_supervisorRoles.name));
  return rows.map(parseRole);
}

export async function getSupervisorRole(
  id: string,
  exec: DbExecutor = db,
): Promise<SupervisorRole | null> {
  const [row] = await exec
    .select()
    .from(_supervisorRoles)
    .where(eq(_supervisorRoles.id, supervisorRoleIdKind.key(id)))
    .limit(1);
  return row ? parseRole(row) : null;
}

/** How a role reads in a list an agent gets: its name and id. */
function describeRoles(roles: readonly SupervisorRole[]): string {
  return roles.length === 0
    ? "none"
    : roles.map((r) => `"${r.id}" (${r.name})`).join(", ");
}

/**
 * The role a filing names: a LISTED role's id, or `"fallback"` — the fallback
 * role, listed or not. Anything else throws, naming what may be named.
 */
export async function resolveFilingRole(ref: string): Promise<SupervisorRole> {
  const roles = await listSupervisorRoles();
  const listed = roles.filter((r) => r.listed);
  if (ref === FALLBACK_ROLE_REF) {
    const fallback = roles.find((r) => r.fallback);
    if (!fallback)
      throw new Error(
        "No supervisor role is the fallback (no role exists yet): file the task without `supervisor`.",
      );
    return fallback;
  }
  const role = listed.find((r) => r.id === ref);
  if (!role)
    throw new Error(
      `No listed supervisor role "${ref}". Name one of: ${describeRoles(listed)} — or "${FALLBACK_ROLE_REF}" when none fits.`,
    );
  return role;
}

/** The role that owns `taskId`, or `null` for none. */
export async function supervisorOfTask(
  taskId: string,
  exec: DbExecutor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ supervisor: tasksSupervisor.table.supervisor })
    .from(tasksSupervisor.table)
    .where(eq(tasksSupervisor.table.taskId, taskId))
    .limit(1);
  return row?.supervisor ?? null;
}

/** Route `taskId` to `roleId` (`null`: no role). The role must exist. */
export async function setTaskSupervisorRole(
  taskId: string,
  roleId: string | null,
  exec: DbExecutor = db,
): Promise<void> {
  if (roleId === null) {
    await tasksSupervisor.delete(taskId, exec);
    return;
  }
  // Keep who asked when a backlog task only changes hands.
  const existing = await tasksSupervisor.get(taskId, exec);
  await tasksSupervisor.upsert(
    taskId,
    {
      supervisor: roleId,
      filedFromTaskId: existing?.filedFromTaskId ?? null,
    },
    exec,
  );
}

/**
 * The role a conversation's session works for: its mandate root's
 * `supervisor`, when that mandate is a role's. `null` for any other
 * conversation. A role mandate root with no role throws — its powers would
 * silently scope to nothing.
 */
export async function roleOfConversation(
  conversationId: string,
): Promise<{ roleId: string; rootTaskId: string } | null> {
  const mandate = await conversationMandate(conversationId);
  if (mandate.kind === "none" || mandate.mandateId !== supervisorRoleMandate.id)
    return null;
  const roleId = await supervisorOfTask(mandate.rootTaskId);
  if (roleId === null)
    throw new Error(
      `Task ${mandate.rootTaskId} states the supervisor-role mandate but no supervisor role owns it (tasks_ext_supervisor).`,
    );
  return { roleId, rootTaskId: mandate.rootTaskId };
}

export interface RoleTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: Date;
  filedFromTaskId: string | null;
}

/** The most backlog rows one read returns (the oldest first). */
export const BACKLOG_READ_LIMIT = 200;

function roleRoots(roleId: string, sessions: boolean) {
  return and(
    eq(tasksSupervisor.table.supervisor, roleId),
    isNull(tasksView.folderId),
    sessions
      ? eq(_tasks.mandateRef, supervisorRoleMandate.id)
      : ne(_tasks.mandateRef, supervisorRoleMandate.id),
  );
}

async function roleRootRows(
  roleId: string,
  sessions: boolean,
  statuses: { in: readonly TaskStatus[] } | { notIn: readonly TaskStatus[] },
  order: "oldest" | "newest",
  limit: number,
  exec: DbExecutor,
): Promise<RoleTaskRow[]> {
  return exec
    .select({
      id: tasksView.id,
      title: tasksView.title,
      status: tasksView.status,
      createdAt: tasksView.createdAt,
      filedFromTaskId: tasksSupervisor.table.filedFromTaskId,
    })
    .from(tasksView)
    .innerJoin(_tasks, eq(_tasks.id, tasksView.id))
    .innerJoin(
      tasksSupervisor.table,
      eq(tasksSupervisor.table.taskId, tasksView.id),
    )
    .where(
      and(
        roleRoots(roleId, sessions),
        "in" in statuses
          ? inArray(tasksView.status, [...statuses.in])
          : notInArray(tasksView.status, [...statuses.notIn]),
      ),
    )
    .orderBy(
      order === "oldest" ? asc(tasksView.createdAt) : desc(tasksView.createdAt),
    )
    .limit(limit);
}

/** Role `roleId`'s backlog, oldest first (`roleBacklogWhere`, server side). */
export function roleBacklog(
  roleId: string,
  exec: DbExecutor = db,
): Promise<RoleTaskRow[]> {
  return roleRootRows(
    roleId,
    false,
    { in: BACKLOG_STATUSES },
    "oldest",
    BACKLOG_READ_LIMIT,
    exec,
  );
}

/** Role `roleId`'s live session root, or `null` when none is live. */
export async function liveSessionOf(
  roleId: string,
  exec: DbExecutor = db,
): Promise<RoleTaskRow | null> {
  // Filtered in SQL, newest first: however many sessions the role has had,
  // the live one is found (`isLiveSessionStatus`'s rule, as a query).
  const [live] = await roleRootRows(
    roleId,
    true,
    { notIn: ENDED_SESSION_STATUSES },
    "newest",
    1,
    exec,
  );
  return live ?? null;
}

export interface BacklogFiling {
  title: string;
  description: string | null;
  track: TaskTrack;
  /** A listed role's id, or `"fallback"`. */
  supervisor: string;
  /** The filing agent's conversation and task. */
  conversationId: string;
  fromTaskId: string;
}

/**
 * File a task into a role's backlog: a ROOT task (it sits in no tree, so it
 * waits for whichever session adopts it), stating the interactive mandate —
 * every root names one, and a person launching it by hand gets an ordinary
 * agent — owned by the role, never armed. The filer's task is kept on it
 * (`filedFromTaskId`). One transaction.
 */
export async function fileToBacklog(
  filing: BacklogFiling,
): Promise<{ taskId: string; role: SupervisorRole }> {
  const role = await resolveFilingRole(filing.supervisor);
  const taskId = await db.transaction(async (tx) => {
    const task = await createTask(
      {
        mandate: interactiveMandate,
        title: filing.title,
        // The agent authored this title deliberately — keep it in the prompt.
        titleAuto: false,
        description: filing.description,
        filing: {
          author: { kind: "agent", conversationId: filing.conversationId },
          filedFrom: asPluginId("tasks.supervisor-roles"),
        },
      },
      tx,
    );
    await tasksSupervisor.upsert(
      task.id,
      { supervisor: role.id, filedFromTaskId: filing.fromTaskId },
      tx,
    );
    await setTaskTrack(task.id, filing.track, tx);
    return task.id;
  });
  return { taskId, role };
}

/** Whether `taskId` is a role session's root: it states the supervisor-role
 * mandate itself (filed at the root, or since dragged under a folder) — its
 * role is fixed: the session works for it, and the mandate needs it. */
export async function isSessionRoot(
  taskId: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: _tasks.id })
    .from(_tasks)
    .where(
      and(
        eq(_tasks.id, taskId),
        eq(_tasks.mandateRef, supervisorRoleMandate.id),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Serializes everything that starts or ends a role's sessions on `exec`'s
 * transaction: a launch (one live session per role) and the role's delete.
 */
export async function lockRoleSessions(
  roleId: string,
  exec: DbExecutor,
): Promise<void> {
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`supervisor-role-session:${roleId}`}))`,
  );
}

/** Why a role could not be deleted. */
export type RoleDeleteRefusal =
  { kind: "live-session"; taskId: string } | { kind: "backlog"; count: number };

/**
 * Delete role `roleId` on `tx`, releasing what it owns. Refused while work
 * waits on it or runs for it: a live session (end it first), or a backlog
 * (route it to another role first). Otherwise its ended sessions and the
 * other roots it owns are RELEASED, not deleted: each task stating the
 * supervisor-role mandate itself (an ended session's root) states the
 * interactive mandate instead — the role mandate needs a role, and a
 * resumed session has none to work for any more — and every owner row
 * goes, then the role. The tasks, their trees and their conversations stay.
 */
export async function deleteRoleReleasing(
  roleId: string,
  tx: DbExecutor,
): Promise<RoleDeleteRefusal | null> {
  await lockRoleSessions(roleId, tx);
  const live = await liveSessionOf(roleId, tx);
  if (live) return { kind: "live-session", taskId: live.id };
  const backlog = await roleBacklog(roleId, tx);
  if (backlog.length > 0) return { kind: "backlog", count: backlog.length };
  const sessionRoots = await tx
    .select({ id: _tasks.id })
    .from(_tasks)
    .innerJoin(
      tasksSupervisor.table,
      eq(tasksSupervisor.table.taskId, _tasks.id),
    )
    .where(
      and(
        eq(tasksSupervisor.table.supervisor, roleId),
        eq(_tasks.mandateRef, supervisorRoleMandate.id),
      ),
    );
  for (const { id } of sessionRoots)
    await setMandate(id, interactiveMandate, tx);
  await tx
    .delete(tasksSupervisor.table)
    .where(eq(tasksSupervisor.table.supervisor, roleId));
  await tx
    .delete(_supervisorRoles)
    .where(eq(_supervisorRoles.id, supervisorRoleIdKind.key(roleId)));
  return null;
}
