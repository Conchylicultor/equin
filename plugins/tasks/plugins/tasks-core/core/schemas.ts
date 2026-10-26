import { z } from "zod";
import { AttemptSchema, ConversationSchema } from "./internal/schema";

export const ConversationSummarySchema = ConversationSchema.pick({
  id: true,
  title: true,
  status: true,
  kind: true,
  createdAt: true,
  spawnedBy: true,
  statusUnverifiedSince: true,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const AttemptWithConversationsSchema = AttemptSchema.extend({
  conversations: z.array(ConversationSummarySchema),
});
export type AttemptWithConversations = z.infer<typeof AttemptWithConversationsSchema>;
