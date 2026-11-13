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

export const AdoptBacklogTaskBodySchema = z.object({
  /** The model the adopted task (and a session launched for it) runs on; absent: the default. */
  model: ModelChoiceSchema.optional(),
});
export type AdoptBacklogTaskBody = z.infer<typeof AdoptBacklogTaskBodySchema>;

export const AdoptBacklogTaskResponseSchema = z.object({
  /** The live session's root task the task now sits under. */
  sessionTaskId: z.string(),
  /** `true`: no session was live — this adopt launched one. */
  sessionStarted: z.boolean(),
});
export type AdoptBacklogTaskResponse = z.infer<
  typeof AdoptBacklogTaskResponseSchema
>;

/**
 * Adopt a backlog task from the Supervisors pane: into the role's live
 * session, launching one first when none is live — the task moves under the
 * session's root and is armed. 409 when it left the backlog (adopted, routed,
 * launched) or is held.
 */
export const adoptBacklogTask = defineEndpoint({
  route: "POST /api/supervisor-roles/:id/backlog/:taskId/adopt",
  body: AdoptBacklogTaskBodySchema,
  response: AdoptBacklogTaskResponseSchema,
});
