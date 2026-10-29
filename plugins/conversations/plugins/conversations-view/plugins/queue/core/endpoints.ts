import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const ReorderBodySchema = z.object({
  conversationId: z.string().min(1),
  targetId: z.string().min(1),
  zone: z.enum(["before", "after"]),
});

export const reorderQueue = defineEndpoint({
  route: "POST /api/conversations-queue/reorder",
  body: ReorderBodySchema,
  // `watermark` is the commit's ack token (`currentTxId` read inside the write
  // transaction) — the optimistic overlay uses it for causal confirmation. A
  // self-target no-op reorder returns no watermark (nothing was written).
  response: z.object({ watermark: z.string().optional() }),
  // Its one client (`use-queue-rows`) already shows the move at once through
  // `useOptimisticResource`, computing the deck's new order with
  // `applyReorder`, and confirms it by this `watermark`.
  unpredicted: {
    reason: "response",
    why: "The sidebar predicts the move itself over the whole deck (useOptimisticResource + applyReorder) and confirms it with the watermark this answers. The rank is a function of the whole current deck and its task groups (a group's members are reseated together, blocked dependents cascade), none of which the request carries.",
  },
});

const ConversationIdBodySchema = z.object({
  conversationId: z.string().min(1),
});

export const promoteQueue = defineEndpoint({
  route: "POST /api/conversations-queue/promote",
  body: ConversationIdBodySchema,
  unpredicted: {
    reason: "server-decided",
    why: "The rank is a function of the whole current deck and its task groups (a group's members are reseated together, blocked dependents cascade), none of which the request carries.",
  },
});

export const demoteQueue = defineEndpoint({
  route: "POST /api/conversations-queue/demote",
  body: ConversationIdBodySchema,
  unpredicted: {
    reason: "server-decided",
    why: "The rank is a function of the whole current deck and its task groups (a group's members are reseated together, blocked dependents cascade), none of which the request carries.",
  },
});

const StepDownBodySchema = z.object({
  conversationId: z.string().min(1),
  steps: z.number().int().positive(),
});

export const stepDownQueue = defineEndpoint({
  route: "POST /api/conversations-queue/step-down",
  body: StepDownBodySchema,
  unpredicted: {
    reason: "server-decided",
    why: "The rank is a function of the whole current deck and its task groups (a group's members are reseated together, blocked dependents cascade), none of which the request carries.",
  },
});

export const rerankQueue = defineEndpoint({
  route: "POST /api/conversations-queue/rerank",
  body: ConversationIdBodySchema,
  unpredicted: {
    reason: "server-decided",
    why: "The rank is a function of the whole current deck and its task groups (a group's members are reseated together, blocked dependents cascade), none of which the request carries.",
  },
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
  unpredicted: {
    reason: "server-decided",
    why: "The pin covers the conversation's whole task group (every member, not named by the request) and seeds a rank row when the conversation has none, joining the group's seat or the top of the deck.",
  },
});
