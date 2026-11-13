import { z } from "zod";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const LaunchRoleSessionBodySchema = z.object({
  /** The model the session's root launches with; absent: the default. */
  model: ModelChoiceSchema.optional(),
});
export type LaunchRoleSessionBody = z.infer<typeof LaunchRoleSessionBodySchema>;

export const LaunchRoleSessionResponseSchema = z.object({
  /** The live session's root task. */
  taskId: z.string(),
  /** `false`: a session was already live — this is it, nothing launched. */
  started: z.boolean(),
});
export type LaunchRoleSessionResponse = z.infer<
  typeof LaunchRoleSessionResponseSchema
>;

/**
 * Open the role's live session, launching one when none is live (a role has
 * one live session at a time, so two cannot adopt from one backlog): a root
 * task stating the supervisor-role mandate, owned by the role, its brief the
 * role's prompt, armed to launch at once.
 */
export const launchRoleSession = defineEndpoint({
  route: "POST /api/supervisor-roles/:id/sessions",
  body: LaunchRoleSessionBodySchema,
  response: LaunchRoleSessionResponseSchema,
});
