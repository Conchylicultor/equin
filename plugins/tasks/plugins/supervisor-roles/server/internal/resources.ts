import { serveCollection } from "@plugins/network/plugins/live/server";
import { supervisorRoles, taskSupervisors } from "../../core";
import { supervisorRolesEntity, tasksSupervisor } from "./tables";

// The roles, whole: every field is a column by name. A role write reaches the
// set through the change feed.
export const supervisorRolesServed = serveCollection(supervisorRoles, {
  from: supervisorRolesEntity,
});

// The `:rows` point resource over `tasks_ext_supervisor`: a route (or the
// task's delete, by cascade) reaches only the tuples naming that task.
export const taskSupervisorsServed = serveCollection(taskSupervisors, {
  from: tasksSupervisor,
});
