import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { BroadcastEntrySchema } from "./endpoints";

/**
 * The broadcast messages in the main checkout's
 * `plugins/framework/plugins/cli/broadcasts.json`, with the file's path. An
 * absent file is no broadcasts; a file that is not a list of broadcasts is
 * refused `malformed` (the CLI ignores it, so the pane says why).
 */
export const broadcastEntries = liveValue("broadcasts.entries", {
  schema: z.object({
    entries: z.array(BroadcastEntrySchema),
    path: z.string(),
  }),
  refusals: ["malformed"],
});
