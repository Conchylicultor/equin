import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { conversationSectionIdKind } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";

// The writes of the roles set. Rows reach clients only through the
// `supervisor-roles.all` collection, which every write reaches through the
// change feed.

const RoleNameSchema = z.string().trim().min(1).max(80);

export const CreateSupervisorRoleBodySchema = z.object({
  name: RoleNameSchema,
  description: z.string().optional(),
  prompt: z.string().optional(),
  /** Absent: listed. */
  listed: z.boolean().optional(),
  /** A person's pick (never re-picked); absent: Haiku picks one. */
  icon: SavedSymbolNameSchema.optional(),
});
export type CreateSupervisorRoleBody = z.infer<
  typeof CreateSupervisorRoleBodySchema
>;

/**
 * Create a role. A name another role has (case-insensitive) is a 400, as is one past `SUPERVISOR_ROLES_MAX`.
 */
export const createSupervisorRole = defineEndpoint({
  route: "POST /api/supervisor-roles",
  body: CreateSupervisorRoleBodySchema,
  response: z.object({ id: z.string() }),
});

export const UpdateSupervisorRoleBodySchema = z.object({
  name: RoleNameSchema.optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  listed: z.boolean().optional(),
  /**
   * A person's pick, never re-picked; `null` hands the icon back to Haiku,
   * which picks one again.
   */
  icon: SavedSymbolNameSchema.nullable().optional(),
  /**
   * The queue section new sessions land in (a user section's id); `null`:
   * the Queue. An unknown section is a 400.
   */
  section: conversationSectionIdKind.schema.nullable().optional(),
});
export type UpdateSupervisorRoleBody = z.infer<
  typeof UpdateSupervisorRoleBodySchema
>;

/** Edit a role in place; a name or description change re-picks an auto icon. */
export const updateSupervisorRole = defineEndpoint({
  route: "PATCH /api/supervisor-roles/:id",
  body: UpdateSupervisorRoleBodySchema,
});

/**
 * Delete a role. Refused (409) while it has a live session (end it first) or
 * a backlog (route it to another role first). Otherwise what it owned is
 * released, never deleted: its ended sessions' roots state the interactive
 * mandate instead, and the tasks lose their owner.
 */
export const deleteSupervisorRole = defineEndpoint({
  route: "DELETE /api/supervisor-roles/:id",
});

export const SetTaskSupervisorBodySchema = z.object({
  /** The role that owns the task from now on; `null`: no role. */
  supervisor: z.string().min(1).nullable(),
});
export type SetTaskSupervisorBody = z.infer<typeof SetTaskSupervisorBodySchema>;

/**
 * Route a task to a role (the task header's Supervisor select): a backlog
 * task moves to that role's backlog; `null` takes it out of every backlog.
 * An unknown role is a 400.
 */
export const setTaskSupervisor = defineEndpoint({
  route: "PUT /api/tasks/:taskId/supervisor",
  body: SetTaskSupervisorBodySchema,
});
