import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { listActiveConversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  conversationMandate,
  mandateOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { mandateDefinitionEntries } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import {
  MANDATE_CHANGE_LEAD,
  routeMandateChange,
  runHandedOverLead,
  sideChatMandateNote,
} from "./notice";
import { sendNote, sendSectionNotice } from "./send";

/** A stored mandate id in words: its definition's label (an id nothing
 * defines throws, as resolving it does). */
function mandateLabel(id: string): string {
  const definition = mandateDefinitionEntries().get(id);
  if (definition === undefined)
    throw new Error(`Mandate "${id}" is stored but no plugin defines it`);
  return definition.mandate.label;
}

/**
 * On a mandate change: each live agent RUNNING one of the moved tasks
 * reconnects the equin MCP server (its tools follow at once), then is sent a
 * notice carrying every system-prompt section that follows the mandate
 * (`## Mandate`, the supervisor prompt, …), rendered again — its system prompt
 * is fixed for the life of its process (`sendSectionNotice`). A conversation
 * opened beside the one running its task states its own mandate, which did
 * not move: it is only told so, never sent sections that read as a change.
 */
export const onMandateChangedJob = defineJob({
  name: "mandate-change-notice.on-change",
  description:
    "When tasks' effective mandate changes, makes each live agent running them reconnect the equin MCP server (its tools follow the new mandate) and sends it every system-prompt section that follows the mandate (Mandate, Supervisor prompt, Task tree…), rendered again, as an informational turn, the way a user message is sent; a side chat opened beside the agent running the task keeps its own mandate and is only told that nothing changed for it.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ taskIds: z.array(z.string()) }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const { follows, side } = routeMandateChange(
      await listActiveConversations(),
      new Set(event.taskIds),
    );
    await Promise.all([
      ...follows.map((c) =>
        sendSectionNotice(c, {
          lead: MANDATE_CHANGE_LEAD,
          pick: (s) => s.followsMandate,
          reconnectMcp: true,
        }),
      ),
      ...side.map(async (c) => {
        const task = await mandateOf(c.taskId);
        if (task.kind === "none" || c.mandateRef === null) return;
        await sendNote(
          c,
          sideChatMandateNote(
            mandateLabel(task.mandateId),
            mandateLabel(c.mandateRef),
          ),
        );
      }),
    ]);
  },
});

/**
 * When a conversation takes over running its task (the one it was opened
 * beside closed — tasks-core's `handOverTaskRuns`): it now works under its
 * task's mandate, so a live agent reconnects the equin MCP server and is sent
 * the mandate's sections again, as on a mandate change.
 */
export const onRunHandedOverJob = defineJob({
  name: "mandate-change-notice.on-run-handed-over",
  description:
    "When a conversation opened beside its task's own one takes over running the task (that one closed), makes its live agent reconnect the equin MCP server (its tools follow the task's mandate) and sends it every system-prompt section that follows the mandate, rendered again, as an informational turn.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ conversationIds: z.array(z.string()) }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const ids = new Set(event.conversationIds);
    const live = (await listActiveConversations()).filter((c) => ids.has(c.id));
    await Promise.all(
      live.map(async (c) => {
        const mandate = await conversationMandate(c.id);
        if (mandate.kind === "none") return;
        await sendSectionNotice(c, {
          lead: runHandedOverLead(mandateLabel(mandate.mandateId)),
          pick: (s) => s.followsMandate,
          reconnectMcp: true,
        });
      }),
    );
  },
});
