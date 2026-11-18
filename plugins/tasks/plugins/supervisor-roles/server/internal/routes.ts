import { count, eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { _conversationSections } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import type { ConversationSectionId } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import {
  createSupervisorRole,
  deleteSupervisorRole,
  setTaskSupervisor,
  SUPERVISOR_ROLES_MAX,
  supervisorRoleIdKind,
  updateSupervisorRole,
} from "../../core";
import { _supervisorRoles } from "./tables";
import {
  supervisorRoleIconStale,
  supervisorRolesListingChanged,
} from "./tables-events";
import { listingChanged } from "./listing-changed";
import {
  deleteRoleReleasing,
  getSupervisorRole,
  routeRefusal,
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

async function assertSectionExists(id: ConversationSectionId): Promise<void> {
  const [row] = await db
    .select({ id: _conversationSections.id })
    .from(_conversationSections)
    .where(eq(_conversationSections.id, id))
    .limit(1);
  if (!row) throw new HttpError(400, `No queue section "${id}".`);
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
      if (body.listed ?? true)
        await supervisorRolesListingChanged.emit({ roleId: id }, { tx });
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
    if (body.section != null) await assertSectionExists(body.section);
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
          ...(body.section !== undefined ? { section: body.section } : {}),
        })
        .where(eq(_supervisorRoles.id, role.id));
      if (repick)
        await supervisorRoleIconStale.emit({ roleId: role.id }, { tx });
      const after = {
        listed: body.listed ?? role.listed,
        name: body.name ?? role.name,
        description: body.description ?? role.description,
      };
      if (listingChanged(role, after))
        await supervisorRolesListingChanged.emit({ roleId: role.id }, { tx });
    });
  },
);

export const handleDeleteSupervisorRole = implement(
  deleteSupervisorRole,
  async ({ params }) => {
    const role = await getSupervisorRole(params.id);
    if (!role) throw new HttpError(404, `No supervisor role "${params.id}".`);
    const refusal = await db.transaction(async (tx) => {
      const refused = await deleteRoleReleasing(role.id, tx);
      if (refused === null && listingChanged(role, null))
        await supervisorRolesListingChanged.emit({ roleId: role.id }, { tx });
      return refused;
    });
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
    const refusal = await routeRefusal(params.taskId);
    if (refusal?.kind === "not-found")
      throw new HttpError(404, `No task "${params.taskId}".`);
    if (refusal?.kind === "session-root")
      throw new HttpError(
        409,
        `${params.taskId} is a role session's root: its role is what the session works for, so it cannot change.`,
      );
    if (refusal?.kind === "in-session")
      throw new HttpError(
        409,
        `${params.taskId} sits in the role session rooted at ${refusal.rootTaskId}: it belongs to that session, so its supervisor cannot change.`,
      );
    if (refusal?.kind === "has-run")
      throw new HttpError(
        409,
        `${params.taskId} is ${refusal.status}: a backlog holds only tasks no agent has run, so its supervisor cannot change.`,
      );
    if (
      body.supervisor !== null &&
      (await getSupervisorRole(body.supervisor)) === null
    )
      throw new HttpError(400, `No supervisor role "${body.supervisor}".`);
    await setTaskSupervisorRole(params.taskId, body.supervisor);
  },
);
