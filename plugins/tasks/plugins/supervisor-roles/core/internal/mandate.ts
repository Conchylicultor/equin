import { z } from "zod";
import {
  defineCapability,
  defineMandate,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";

/**
 * The mandate of a supervisor role's session root: the supervisor preset
 * (`tasks/mandate-presets`) plus the role powers ({@link supervisorRole} on
 * the root). ONE named mandate for every role: which role a session works
 * for is its root task's `supervisor` field — never a second copy of it in
 * the mandate id, which could disagree with the field. A kind of supervisor
 * (`extends`), so whatever asks "is this a supervisor?" counts its sessions.
 */
export const supervisorRoleMandate = defineMandate({
  id: "supervisor-role",
  label: "Supervisor role",
  extends: supervisorMandate,
});

/**
 * The role powers, the same for every role: list the role's backlog, adopt a
 * backlog task into the live session, route a task to another role, and
 * manage (edit, drop) every task the role owns — its backlog and its earlier
 * session trees (a `MandateReach`). Granted to a role session's root only.
 */
export const supervisorRole = defineCapability<true>({
  id: "supervisor-roles.role",
  schema: z.literal(true),
  label: "Work a supervisor role's backlog",
});
