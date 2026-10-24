import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
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
    entries: wholeList(BroadcastEntrySchema, {
      reason:
        "one hand-written broadcasts.json — the few messages a maintainer is broadcasting to stale worktrees",
    }),
    path: z.string(),
  }),
  refusals: ["malformed"],
});
