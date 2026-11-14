import { sql } from "drizzle-orm";
import { uniqueIndex } from "drizzle-orm/pg-core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { _conversationSections } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { supervisorRolesEntityRef, taskSupervisorShape } from "../../core";

// Physical tables, derived from the field records in `core/`. A load-order
// leaf (drizzle-kit's sync loader evaluates it); the pgTables are re-exported
// with a leading `_` for drizzle-kit's schema glob.

export const supervisorRolesEntity = defineEntity(supervisorRolesEntityRef, {
  primaryKey: "id",
  columns: {
    iconByUser: { default: false },
    listed: { default: true },
    description: { default: "" },
    prompt: { default: "" },
    // A deleted section sends the role's next sessions back to the Queue.
    section: {
      references: {
        column: () => _conversationSections.id,
        onDelete: "set null",
      },
    },
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [
    // Agents name a role by id, people by name: two roles of one name would
    // read as one in every list.
    uniqueIndex("supervisor_roles_name_idx").on(sql`lower(${t.name})`),
  ],
});
export const _supervisorRoles = supervisorRolesEntity.table;

/**
 * Per-task supervisor (see `taskSupervisorShape`). The role is a foreign key
 * with ON DELETE RESTRICT: a role that still owns a task cannot be deleted —
 * route its tasks first (the delete endpoint says so before the database
 * would).
 */
export const tasksSupervisor = defineExtension(
  _tasks,
  "supervisor",
  taskSupervisorShape,
  {
    columns: {
      supervisor: {
        references: {
          column: () => _supervisorRoles.id,
          onDelete: "restrict",
          onUpdate: "cascade",
        },
      },
    },
  },
);
export const _tasksSupervisorExt = tasksSupervisor.table;
