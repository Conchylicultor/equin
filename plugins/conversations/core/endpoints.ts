import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ConversationSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";
import {
  turnIdKind,
  TurnStateSchema,
} from "@plugins/conversations/plugins/turn-ledger/core";

// --- Body schemas ---

export const CreateConversationBodySchema = z
  .object({
    taskId: z.string().optional(),
    attemptId: z.string().optional(),
    prompt: z.string().optional(),
    runtime: z.string().optional(),
    // Strict enum — an unknown/typo model id is rejected loudly at the endpoint
    // boundary (400) rather than silently coerced to the default. A family
    // ("opus") or a pinned version; the spawn resolves it. This is an *input*
    // schema; stored model fields read back from the DB stay tolerant.
    model: ModelChoiceSchema.optional(),
    forkFromConversationId: z.string().optional(),
    // With `forkFromConversationId`: fork from just before this user message (its
    // transcript line uuid, carried by the `user-text` row) rather than the end.
    forkAtMessageUuid: z.string().optional(),
    // Where a NEW attempt runs (default: a worktree). A scratch spec's input is
    // validated by its profile when the attempt is created.
    workspace: WorkspaceSpecSchema.optional(),
  })
  .refine((b) => !b.forkAtMessageUuid || !!b.forkFromConversationId, {
    message: "forkAtMessageUuid requires forkFromConversationId",
    path: ["forkAtMessageUuid"],
  });
export type CreateConversationBody = z.infer<
  typeof CreateConversationBodySchema
>;

export const PostTurnBodySchema = z.object({
  text: z.string().min(1),
  /**
   * The turn's ledger id (conversations/turn-ledger), minted by the client so a
   * repeated request is a no-op. Omitted by older clients: the server mints one.
   */
  turnId: turnIdKind.schema.optional(),
});
export type PostTurnBody = z.infer<typeof PostTurnBodySchema>;

// --- Query schemas ---

export const ListTurnsQuerySchema = z.object({
  since: z.string().optional(),
});
export type ListTurnsQuery = z.infer<typeof ListTurnsQuerySchema>;

export const DeleteConversationQuerySchema = z.object({
  name: z.string(),
});
export type DeleteConversationQuery = z.infer<
  typeof DeleteConversationQuerySchema
>;

// --- Endpoint definitions ---

export const listConversations = defineEndpoint({
  route: "GET /api/conversations",
  response: z.array(ConversationSchema),
});

export const getConversation = defineEndpoint({
  route: "GET /api/conversations/:id",
  response: ConversationSchema,
});

export const createConversation = defineEndpoint({
  route: "POST /api/conversations",
  body: CreateConversationBodySchema,
  response: ConversationSchema,
  // Regression backstop: the interactive Launch path must never again block on
  // worktree-scale subprocess work (the `setupWorktree` checkout is now off in a
  // durable job). If this endpoint's in-process time creeps back over 1 s, the
  // slow-ops pipeline files a report — catching any re-introduced blocking work.
  slowThresholdMs: 1000,
});

export const deleteConversation = defineEndpoint({
  route: "DELETE /api/conversations",
  query: DeleteConversationQuerySchema,
});

export const postConversationTurn = defineEndpoint({
  route: "POST /api/conversations/:id/turn",
  body: PostTurnBodySchema,
  // The server's finalText (attachment refs rewritten to @<disk-path>, trimmed).
  // The pending-turn store matches THIS against the transcript — the raw draft
  // never appears verbatim in the session JSONL. `held`: the conversation was
  // still `starting`, so the server kept the turn and delivers it once the agent
  // can take input (server/internal/turns.ts). `turnId`: the turn's ledger
  // row — the client's own id when it sent one.
  response: z.object({
    resolvedText: z.string(),
    held: z.boolean(),
    turnId: z.string(),
  }),
});

/**
 * Type a `failed` or `unverified` ledger turn again (404 unknown turn, 409 any
 * other state). Answers with where the row stands after the attempt.
 */
export const retryConversationTurn = defineEndpoint({
  route: "POST /api/conversations/:id/turns/:turnId/retry",
  response: z.object({ turnId: z.string(), state: TurnStateSchema }),
});

/**
 * Take a `failed` or `unverified` ledger turn back instead of retrying it: it
 * becomes `withdrawn` (the client put its text in the draft). 404 unknown turn,
 * 409 any other state.
 */
export const withdrawConversationTurn = defineEndpoint({
  route: "POST /api/conversations/:id/turns/:turnId/withdraw",
  response: z.object({ turnId: z.string(), state: TurnStateSchema }),
});

export const stopConversation = defineEndpoint({
  route: "POST /api/conversations/:id/stop",
  response: z.object({ ok: z.boolean(), rewindText: z.string().nullable() }),
});

const TurnSchema = z.object({
  at: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  stopReason: z.string().optional(),
  messageId: z.string().optional(),
});

export const listConversationTurns = defineEndpoint({
  route: "GET /api/conversations/:id/turns",
  query: ListTurnsQuerySchema,
  response: z.object({
    turns: z.array(TurnSchema),
  }),
});

export const closeConversation = defineEndpoint({
  route: "POST /api/conversations/:id/close",
});
