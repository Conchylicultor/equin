import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

const AllowFilesSchema = z.object({ allowFiles: z.array(z.string()) });
export type AllowFiles = z.infer<typeof AllowFilesSchema>;

// Which guard-bypass files exist at a conversation's worktree root (`id` is the
// conversation id), pushed by a file watcher while someone is looking at the
// conversation. Not known yet is `pending` — never an empty list, which would
// claim no bypass is active. The files are on the computer, so only the
// desktop app answers it (`needsMachine`): under an in-browser server the read
// is `unavailable` — still never an empty list.
export const allowFiles = liveValue("allow-files", {
  schema: AllowFilesSchema,
  params: ["id"],
  needsMachine: { feature: "Checking for guard-bypass files" },
});
