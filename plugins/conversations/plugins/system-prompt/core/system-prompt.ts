import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The tag every contributed section is wrapped in inside the system-prompt
 * append: `<equin-context id="mandate">…</equin-context>`. It keeps sections
 * attributable in the transcript's prompt snapshot.
 */
export const SYSTEM_PROMPT_SECTION_TAG = "equin-context";

/** The id the conversation's preprompt is recorded under (it is not contributed). */
export const PREPROMPT_SECTION_ID = "preprompt";

/** One part of what equin appended to an agent's system prompt, as composed. */
export const SystemPromptSectionRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Its length as appended (JavaScript string length), wrapper included. */
  chars: z.number(),
});
export type SystemPromptSectionRecord = z.infer<
  typeof SystemPromptSectionRecordSchema
>;

// The `conversations_ext_system_prompt` row: what equin appended to the
// agent's system prompt at its LAST spawn (launch or resume), section by
// section — written by the composer as it composes, read by the context card.
export const conversationSystemPromptShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    sections: jsonField({
      schema: wholeList(SystemPromptSectionRecordSchema, {
        reason:
          "one per contributed system-prompt section plus the preprompt: a handful",
      }),
    }),
  },
  wireTimestamps: ["updatedAt"],
});
export type ConversationSystemPrompt = z.infer<
  typeof conversationSystemPromptShape.schema
>;

/**
 * One conversation's system-prompt sections as last composed, by its id —
 * lookup-only: `useLive(conversationSystemPrompt, { id })`, where
 * `found: false` is "not composed since this existed" (an agent spawned before).
 */
export const conversationSystemPrompt = liveCollection(
  "conversations.system-prompt",
  { from: conversationSystemPromptShape, id: "conversationId" },
);

/**
 * A rough token count for text equin wrote (about four characters a token).
 * Only for showing a share of a measured total — never for a budget.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
