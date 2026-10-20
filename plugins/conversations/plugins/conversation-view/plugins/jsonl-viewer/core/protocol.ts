import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { JsonlEventSchema } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * One conversation's parsed transcript chain, pushed whole on every append.
 * Not loaded yet is `pending` (a value has no placeholder) — never `[]`, which
 * would read as a conversation that has said nothing.
 */
export const jsonlEvents = liveValue("jsonl-events", {
  schema: z.array(JsonlEventSchema),
  params: ["id"],
});
