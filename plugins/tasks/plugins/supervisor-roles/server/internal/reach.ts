import { db } from "@plugins/database/server";
import { nearestMandate } from "@plugins/tasks/plugins/tasks-core/server";
import {
  grantOf,
  Mandate,
  MandateReach,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { supervisorRole } from "../../core";
import { roleOfConversation, supervisorOfTask } from "./roles";

/**
 * A role session manages every task its role owns: a task is the role's when
 * the root of the tree it sits in (its nearest mandate's task — a backlog
 * task is its own root) is owned by the role. So the role's backlog and its
 * earlier session trees are in reach, never another role's tasks.
 */
export const supervisorRoleReach = MandateReach({
  id: "supervisor-roles",
  reaches: async (conversationId, taskId) => {
    if ((await grantOf(supervisorRole, conversationId)) === null) return false;
    const role = await roleOfConversation(conversationId);
    if (role === null) return false;
    const root = await nearestMandate(taskId, db);
    if (root.kind === "none") return false;
    return (await supervisorOfTask(root.rootTaskId)) === role.roleId;
  },
});

/** The role powers add no Mandate line: their tools appear only when
 * granted, and the supervisor section names the role. */
export const supervisorRoleCapability = Mandate.Capability({
  cap: supervisorRole,
  describe: () => null,
});
