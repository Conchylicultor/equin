import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { MCP_SERVER_NAME } from "@plugins/infra/plugins/mcp/core";
import { Runtime, submitTurn } from "@plugins/conversations/server";
import { renderMandateInstructions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { listActiveConversations } from "@plugins/tasks/plugins/tasks-core/server";
import { noticeText } from "./notice";

/**
 * On a mandate change: each live agent on the moved tasks reconnects the
 * equin MCP server (its tools follow at once), then is sent a notice carrying
 * the new `## Mandate` section — its system prompt is fixed for the life of
 * its process. The notice is typed now, as a person's message would be
 * (`submitTurn`): a working agent reads it at its next step, an idle one
 * answers it. An agent this backend does not run (`not-running`: another
 * namespace's, hibernated, or none) is skipped: its next start reads the new
 * mandate.
 */
export const onMandateChangedJob = defineJob({
  name: "mandate-change-notice.on-change",
  description:
    "When tasks' effective mandate changes, makes each live agent on them reconnect the equin MCP server (its tools follow the new mandate) and sends it the new Mandate section as an informational turn, the way a user message is sent.",
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
      live.map(async (c) => {
        const outcome = await Runtime.get(c.runtime).reconnectMcp(
          c.id,
          MCP_SERVER_NAME,
        );
        if (outcome === "not-running") return;
        const text = noticeText(await renderMandateInstructions(c.id));
        const out = await submitTurn(c.id, {
          kind: "event",
          text,
          typedText: text,
        });
        if (out.kind === "not-found")
          throw new Error(`mandate notice: conversation ${c.id} not found`);
        if (out.kind === "stopped")
          throw new Error(
            `mandate notice: conversation ${c.id} stopped (${out.status}) after its MCP reconnect`,
          );
      }),
    );
  },
});
