import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { listActiveConversations } from "@plugins/tasks/plugins/tasks-core/server";
import { MANDATE_CHANGE_LEAD } from "./notice";
import { sendSectionNotice } from "./send";

/**
 * On a mandate change: each live agent on the moved tasks reconnects the
 * equin MCP server (its tools follow at once), then is sent a notice carrying
 * every system-prompt section that follows the mandate (`## Mandate`, the
 * supervisor prompt, …), rendered again — its system prompt is fixed for the
 * life of its process (`sendSectionNotice`).
 */
export const onMandateChangedJob = defineJob({
  name: "mandate-change-notice.on-change",
  description:
    "When tasks' effective mandate changes, makes each live agent on them reconnect the equin MCP server (its tools follow the new mandate) and sends it every system-prompt section that follows the mandate (Mandate, Supervisor prompt, Task tree…), rendered again, as an informational turn, the way a user message is sent.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ taskIds: z.array(z.string()) }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const tasks = new Set(event.taskIds);
    const live = (await listActiveConversations()).filter((c) =>
      tasks.has(c.taskId),
    );
    await Promise.all(
      live.map((c) =>
        sendSectionNotice(c, {
          lead: MANDATE_CHANGE_LEAD,
          pick: (s) => s.followsMandate,
          reconnectMcp: true,
        }),
      ),
    );
  },
});
