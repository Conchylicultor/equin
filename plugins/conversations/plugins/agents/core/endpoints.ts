import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";
import { AgentSchema, AgentLaunchWithStatusSchema } from "./schemas";

// --- Body schemas ---
//
// `model` is the strict ModelChoice enum (a family or a pinned version) on
// every input schema: an unknown/typo id is rejected loudly at the endpoint
// boundary (400) rather than stored or launched as a silent default. Stored
// agent.model values read back stay tolerant via StoredModelChoiceSchema.

export const CreateAgentBodySchema = z.object({
  parentId: z.string().nullable().optional(),
  // Positional intent: place the new agent immediately after this sibling.
  // Resolved server-side against the complete sibling set (see rankAfterSibling);
  // omitted ⇒ append at the end.
  afterId: z.string().optional(),
  name: z.string().optional(),
  prompt: z.string().nullable().optional(),
  model: ModelChoiceSchema.nullable().optional(),
  icon: SavedSymbolNameSchema.nullable().optional(),
  iconColor: z.string().nullable().optional(),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

// No `rank`: an agent's position is only ever set through `moveAgent` below,
// which carries positional intent. `parentId` stays here for a plain re-parent
// that makes no positional claim (the agent keeps its existing rank).
export const UpdateAgentBodySchema = z.object({
  name: z.string().optional(),
  prompt: z.string().nullable().optional(),
  model: ModelChoiceSchema.nullable().optional(),
  icon: SavedSymbolNameSchema.nullable().optional(),
  iconColor: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBodySchema>;

/**
 * Positional intent, never a rank (see `CreateAgentBodySchema.afterId`). The
 * agent lands among `parentId`'s children, immediately `zone` of `targetId`.
 *
 * `targetId: null` addresses the sibling-list boundary instead of a neighbour:
 * `"after"` appends at the end, `"before"` prepends at the start. That is what
 * a tree "drop onto this row as a child" gesture means.
 */
export const MoveAgentBodySchema = z.object({
  parentId: z.string().nullable(),
  targetId: z.string().nullable(),
  zone: z.enum(["before", "after"]),
});
export type MoveAgentBody = z.infer<typeof MoveAgentBodySchema>;

export const LaunchAgentBodySchema = z.object({
  model: ModelChoiceSchema.optional(),
});
export type LaunchAgentBody = z.infer<typeof LaunchAgentBodySchema>;

export const LaunchAgentResponseSchema = z.object({
  launchId: z.string(),
  taskId: z.string(),
  conversationId: z.string(),
});
export type LaunchAgentResponse = z.infer<typeof LaunchAgentResponseSchema>;

// --- Endpoint definitions ---

export const listAgents = defineEndpoint({
  route: "GET /api/agents",
  response: z.array(AgentSchema),
});

export const createAgent = defineEndpoint({
  route: "POST /api/agents",
  body: CreateAgentBodySchema,
  response: AgentSchema,
});

export const getAgent = defineEndpoint({
  route: "GET /api/agents/:id",
  response: AgentSchema,
});

export const updateAgent = defineEndpoint({
  route: "PATCH /api/agents/:id",
  body: UpdateAgentBodySchema,
  response: AgentSchema,
});

// Reposition an agent in the tree. The rank is minted server-side against the
// complete `parentId` sibling set, inside the write's own transaction — the
// tree that emits this drop only ever holds a projection. Returns nothing: the
// agents live resource pushes the new order.
export const moveAgent = defineEndpoint({
  route: "POST /api/agents/:id/move",
  body: MoveAgentBodySchema,
});

export const deleteAgent = defineEndpoint({
  route: "DELETE /api/agents/:id",
});

// Desktop-only: a launch spawns Claude Code, so it is served by
// `agents/machine` and every client handles "not available".
export const launchAgent = defineEndpoint({
  route: "POST /api/agents/:id/launch",
  body: LaunchAgentBodySchema,
  response: LaunchAgentResponseSchema,
  needsMachine: { feature: "Launching an agent" },
});

export const listAgentLaunches = defineEndpoint({
  route: "GET /api/agents/:id/launches",
  response: z.array(AgentLaunchWithStatusSchema),
});
