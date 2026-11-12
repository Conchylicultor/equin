import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { conversationSectionIdKind } from "./id-kinds";
import { PINNED_SECTION } from "./resources";

const SectionIdSchema = conversationSectionIdKind.schema;

// A section a task group is filed into: `PINNED_SECTION`, a user section's id
// (`csec-…`), or `null` (the Queue). A malformed key is a 400; a well-formed
// user section id that does not exist is the handler's 404.
const SectionKeySchema = z
  .union([z.literal(PINNED_SECTION), SectionIdSchema])
  .nullable();

/** Where a task group is filed: Pinned, a user section, or `null` (the Queue). */
export type QueueSectionKey = z.infer<typeof SectionKeySchema>;

const ZoneSchema = z.enum(["before", "after"]);

const ReorderBodySchema = z.object({
  conversationId: z.string().min(1),
  targetId: z.string().min(1),
  zone: ZoneSchema,
  // Present on a cross-section drop: the group is also filed into this section,
  // in the same transaction as the move. Absent: the section is untouched.
  section: SectionKeySchema.optional(),
});

/**
 * Move a conversation's group next to another's: the server mints the rank.
 * With `section`, the group also moves into that section (a cross-section drop).
 */
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

// File the conversation's whole task group into a section (`PINNED_SECTION`, a
// user section's id) or back to the Queue (`null`). Group-level like the rank
// itself: a group is ONE row in the sidebar, so a per-member section could
// split a group across two sections. An unknown section id is a 404.
export const fileQueue = defineEndpoint({
  route: "POST /api/conversations-queue/file",
  body: z.object({
    conversationId: z.string().min(1),
    section: SectionKeySchema,
  }),
});

const SectionNameSchema = z.string();

// Create a user section, ranked right after `after` (a section id, or
// `PINNED_SECTION` for the first place), else last; with `conversationId`, that
// conversation's group is filed into it in the same transaction.
export const createQueueSection = defineEndpoint({
  route: "POST /api/conversations-queue/sections/create",
  body: z.object({
    name: SectionNameSchema,
    after: z.union([z.literal(PINNED_SECTION), SectionIdSchema]).optional(),
    conversationId: z.string().min(1).optional(),
  }),
  response: z.object({ id: SectionIdSchema }),
});

// Rename a user section; the name is trimmed and must not be empty (400).
export const renameQueueSection = defineEndpoint({
  route: "POST /api/conversations-queue/sections/rename",
  body: z.object({ id: SectionIdSchema, name: SectionNameSchema }),
});

// Move a user section next to another among the sections.
export const moveQueueSection = defineEndpoint({
  route: "POST /api/conversations-queue/sections/move",
  body: z.object({
    id: SectionIdSchema,
    targetId: SectionIdSchema,
    zone: ZoneSchema,
  }),
});

// Delete a user section: its members go back to the Queue (`section = null`).
export const deleteQueueSection = defineEndpoint({
  route: "POST /api/conversations-queue/sections/delete",
  body: z.object({ id: SectionIdSchema }),
});
