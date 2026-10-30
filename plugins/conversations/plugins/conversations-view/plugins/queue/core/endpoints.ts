import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const ReorderBodySchema = z.object({
  conversationId: z.string().min(1),
  targetId: z.string().min(1),
  zone: z.enum(["before", "after"]),
});

/** Move a conversation's group next to another's: the server mints the rank. */
export type ReorderQueueBody = z.infer<typeof ReorderBodySchema>;

export const reorderQueue = defineEndpoint({
  route: "POST /api/conversations-queue/reorder",
  body: ReorderBodySchema,
});

const ConversationIdBodySchema = z.object({
  conversationId: z.string().min(1),
});

export const promoteQueue = defineEndpoint({
  route: "POST /api/conversations-queue/promote",
  body: ConversationIdBodySchema,
});

export const demoteQueue = defineEndpoint({
  route: "POST /api/conversations-queue/demote",
  body: ConversationIdBodySchema,
});

const StepDownBodySchema = z.object({
  conversationId: z.string().min(1),
  steps: z.number().int().positive(),
});

export const stepDownQueue = defineEndpoint({
  route: "POST /api/conversations-queue/step-down",
  body: StepDownBodySchema,
});

export const rerankQueue = defineEndpoint({
  route: "POST /api/conversations-queue/rerank",
  body: ConversationIdBodySchema,
});

// Pin / unpin the conversation's whole task group. Group-level like the rank
// itself: a group is ONE row in the sidebar, so a per-member pin could split a
// group across two sections.
export const pinQueue = defineEndpoint({
  route: "POST /api/conversations-queue/pin",
  body: z.object({
    conversationId: z.string().min(1),
    pinned: z.boolean(),
  }),
});
