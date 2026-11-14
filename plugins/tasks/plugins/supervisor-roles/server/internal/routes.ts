import { count, eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { getTask } from "@plugins/tasks/plugins/tasks-core/server";
import {
  createSupervisorRole,
  deleteSupervisorRole,
  setTaskSupervisor,
  SUPERVISOR_ROLES_MAX,
  supervisorRoleIdKind,
  updateSupervisorRole,
} from "../../core";
import { _supervisorRoles } from "./tables";
import { supervisorRoleIconStale } from "./tables-events";
import {
  deleteRoleReleasing,
  getSupervisorRole,
  isSessionRoot,
  setTaskSupervisorRole,
} from "./roles";

async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const [row] = await db
    .select({ id: _supervisorRoles.id })
    .from(_supervisorRoles)
    .where(sql`lower(${_supervisorRoles.name}) = lower(${name})`)
    .limit(1);
  if (row && row.id !== exceptId)
    throw new HttpError(400, `A supervisor role is already named "${name}".`);
}

export const handleCreateSupervisorRole = implement(
  createSupervisorRole,
  async ({ body }) => {
    await assertNameFree(body.name);
    const id = supervisorRoleIdKind.mint();
    await db.transaction(async (tx) => {
      // Serialize creates: the cap reads the whole set.
      await tx.execute(
        sql`LOCK TABLE ${_supervisorRoles} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(_supervisorRoles);
      if (n >= SUPERVISOR_ROLES_MAX)
        throw new HttpError(
          400,
          `At most ${SUPERVISOR_ROLES_MAX} supervisor roles: delete one first.`,
        );
      await tx.insert(_supervisorRoles).values({
        id,
        name: body.name,
        description: body.description ?? "",
        prompt: body.prompt ?? "",
        listed: body.listed ?? true,
        icon: body.icon ?? null,
        iconByUser: body.icon !== undefined,
      });
      if (body.icon === undefined)
        await supervisorRoleIconStale.emit({ roleId: id }, { tx });
    });
    return { id };
  },
);

export const handleUpdateSupervisorRole = implement(
  updateSupervisorRole,
  async ({ params, body }) => {
    const role = await getSupervisorRole(params.id);
    if (!role) throw new HttpError(404, `No supervisor role "${params.id}".`);
    if (body.name !== undefined) await assertNameFree(body.name, role.id);
    const iconByUser =
      body.icon === undefined ? role.iconByUser : body.icon !== null;
    const textChanged =
      (body.name !== undefined && body.name !== role.name) ||
      (body.description !== undefined && body.description !== role.description);
    // An auto icon is re-picked when what it was picked from changed, or
    // when a person hands the icon back (`icon: null`).
    const repick = !iconByUser && (textChanged || body.icon === null);
    await db.transaction(async (tx) => {
      await tx
        .update(_supervisorRoles)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.listed !== undefined ? { listed: body.listed } : {}),
          ...(body.icon !== undefined ? { icon: body.icon, iconByUser } : {}),
        })
        .where(eq(_supervisorRoles.id, role.id));
      if (repick)
        await supervisorRoleIconStale.emit({ roleId: role.id }, { tx });
    });
  },
);

export const handleDeleteSupervisorRole = implement(
  deleteSupervisorRole,
  async ({ params }) => {
    const role = await getSupervisorRole(params.id);
    if (!role) throw new HttpError(404, `No supervisor role "${params.id}".`);
    const refusal = await db.transaction((tx) =>
      deleteRoleReleasing(role.id, tx),
    );
    if (refusal?.kind === "live-session")
      throw new HttpError(
        409,
        `"${role.name}" has a live session (${refusal.taskId}): end it first.`,
      );
    if (refusal?.kind === "backlog")
      throw new HttpError(
        409,
        `"${role.name}" still has ${refusal.count} task(s) in its backlog: route them to another role first.`,
      );
  },
);

export const handleSetTaskSupervisor = implement(
  setTaskSupervisor,
  async ({ params, body }) => {
    if ((await getTask(params.taskId)) === null)
      throw new HttpError(404, `No task "${params.taskId}".`);
    if (await isSessionRoot(params.taskId))
      throw new HttpError(
        409,
        `${params.taskId} is a role session's root: its role is what the session works for, so it cannot change.`,
      );
    if (
      body.supervisor !== null &&
      (await getSupervisorRole(body.supervisor)) === null
    )
      throw new HttpError(400, `No supervisor role "${body.supervisor}".`);
    await setTaskSupervisorRole(params.taskId, body.supervisor);
  },
);
