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
  unpredicted: {
    reason: "server-minted-id",
    why: "The server mints the agent id and rank, and the list selects the returned row.",
  },
});

export const getAgent = defineEndpoint({
  route: "GET /api/agents/:id",
  response: AgentSchema,
});

export const updateAgent = defineEndpoint({
  route: "PATCH /api/agents/:id",
  body: UpdateAgentBodySchema,
  response: AgentSchema,
  unpredicted: {
    reason: "precondition",
    why: "The server answers 400 for a model that is not launchable and for a parent that is the agent itself or its descendant, and the editors show the refusal.",
  },
});

// Reposition an agent in the tree. The rank is minted server-side against the
// complete `parentId` sibling set, inside the write's own transaction — the
// tree that emits this drop only ever holds a projection. Returns nothing: the
// agents live resource pushes the new order.
export const moveAgent = defineEndpoint({
  route: "POST /api/agents/:id/move",
  body: MoveAgentBodySchema,
  unpredicted: {
    reason: "server-decided",
    why: "The rank is minted against the complete sibling set of the target parent inside the write's transaction; the request names only a neighbour and a side, and the tree that emits it holds a projection.",
  },
});

export const deleteAgent = defineEndpoint({
  route: "DELETE /api/agents/:id",
  unpredicted: {
    reason: "precondition",
    why: "The server answers 409 when the agent has children, and the list shows that refusal instead of removing the row.",
  },
});

// Desktop-only: a launch spawns Claude Code, so it is served by
// `agents/machine` and every client handles "not available".
export const launchAgent = defineEndpoint({
  route: "POST /api/agents/:id/launch",
  body: LaunchAgentBodySchema,
  response: LaunchAgentResponseSchema,
  needsMachine: { feature: "Launching an agent" },
  unpredicted: {
    reason: "server-decided",
    why: "Launching spawns a Claude Code session and creates the task and conversation server-side; the returned ids are what the caller uses.",
  },
});

export const listAgentLaunches = defineEndpoint({
  route: "GET /api/agents/:id/launches",
  response: z.array(AgentLaunchWithStatusSchema),
});
