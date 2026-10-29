import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { granted } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { contextCompact } from "@plugins/conversations/plugins/self-compact/plugins/capability/core";
import { requestCompaction } from "./compaction";

export const compactContextTool = Mcp.tool({
  name: "compact_context",
  when: granted(contextCompact),
  description: `Compact your own context, after a major step, so a long run stays small. Once you end this turn, you are sent \`/compact\` with \`keep\` as its instructions, then \`next\` as your next message.

Call it, then end your turn. Calling it again before then replaces the earlier request.`,
  inputSchema: {
    keep: z
      .string()
      .min(1)
      .describe(
        "What the summary must keep: decisions, open threads, ids you still need. Anything in the task tree you can read again need not be kept.",
      ),
    next: z
      .string()
      .min(1)
      .describe(
        "What you do once compacted — sent to you as your next message.",
      ),
  },
  async handler({ keep, next }, { conversationId }) {
    await requestCompaction(conversationId, { keep, next });
    return {
      content: [
        {
          type: "text",
          text: "Compaction queued: it runs once this turn ends. End your turn now.",
        },
      ],
    };
  },
});
