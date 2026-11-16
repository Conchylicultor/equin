import { db } from "@plugins/database/server";
import { nearestMandate } from "@plugins/tasks/plugins/tasks-core/server";
import {
  grantOf,
  Mandate,
  TaskOwnerClaim,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { supervisorRole } from "../../core";
import {
  getSupervisorRole,
  roleOfConversation,
  supervisorOfTask,
} from "./roles";

/** The role that owns `taskId`: the role owns it itself (a backlog task — a
 * root, or nested in the tree a person routed it from) or owns the root of
 * the tree it sits in (its nearest mandate's task — a session tree). */
async function owningRole(taskId: string): Promise<string | null> {
  const own = await supervisorOfTask(taskId);
  if (own !== null) return own;
  const root = await nearestMandate(taskId, db);
  if (root.kind === "none") return null;
  return supervisorOfTask(root.rootTaskId);
}

/**
 * A role owns its backlog and its session trees, earlier ones included; its
 * sessions act as it — the session's ROOT conversation only (the role powers
 * are granted at the root: a worker of the session manages nothing). So a role
 * session manages every task its role owns, never another role's.
 */
export const supervisorRoleOwnerClaim = TaskOwnerClaim({
  id: "supervisor-roles",
  claim: async (taskId) => {
    const roleId = await owningRole(taskId);
    if (roleId === null) return null;
    const role = await getSupervisorRole(roleId);
    return {
      label: `supervisor role ${role?.name ?? roleId}`,
      owns: async (conversationId) => {
        if ((await grantOf(supervisorRole, conversationId)) === null)
          return false;
        return (await roleOfConversation(conversationId))?.roleId === roleId;
      },
    };
  },
});

/** The role powers add no Mandate line: their tools appear only when
 * granted, and the supervisor section names the role. */
export const supervisorRoleCapability = Mandate.Capability({
  cap: supervisorRole,
  describe: () => null,
});
