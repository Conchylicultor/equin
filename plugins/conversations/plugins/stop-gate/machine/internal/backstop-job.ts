import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { isAgentBusy, conversationRoute } from "@plugins/conversations/core";
import { submitTurn } from "@plugins/conversations/server";
import { automaticTurnReadiness } from "@plugins/conversations/plugins/automatic-turn/server";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { backstopStop, type BackstopPorts } from "./backstop";
import { evaluateStop } from "../../server/internal/decide";
import { StopGate, StopWaiver } from "../../server/internal/registry";

const productionPorts: BackstopPorts = {
  conversation: getConversation,
  decide: (conversationId) =>
    evaluateStop(
      conversationId,
      StopGate.getContributions(),
      StopWaiver.getContributions(),
    ),
  readiness: (conversationId, exec) =>
    automaticTurnReadiness(conversationId, { exec }),
  async submit(conversationId, turn) {
    const out = await submitTurn(conversationId, {
      ...turn,
      typedText: turn.text,
    });
    if (out.kind === "not-found")
      throw new Error(
        `stop backstop: conversation ${conversationId} not found`,
      );
    if (out.kind === "stopped")
      throw new Error(
        `stop backstop: conversation ${conversationId} is ${out.status}`,
      );
  },
  async flag(conversation, reason) {
    await recordNotification({
      type: "stop-gate-unmet",
      variant: "warning",
      title: `Stopped with work owed: ${conversation.taskTitle}`,
      description: reason,
      linkTo: conversationRoute.link(agentManagerApp, {
        convId: conversation.id,
      }),
      metadata: {
        taskId: conversation.taskId,
        conversationId: conversation.id,
      },
      dedupeKey: `stop-gate-unmet:${conversation.id}`,
    });
  },
};

export const stopBackstopJob = defineJob({
  name: "stop-gate.backstop",
  description:
    "When an agent stops while its stop gates would have blocked it (the Stop hook could not reach the app, or it stopped again after a block), types one reminder turn with the gates' reason; if it stops again with the demand unmet, or cannot take a turn, notifies the user.",
  hold: "instant",
  input: z.object({}),
  // Two runs for one conversation at once: the reminders table's PK lets one
  // of them record the reminder, and the turn id it mints makes a re-submit a
  // no-op.
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      status: ConversationStatusSchema,
    })
    .passthrough(),
  // Main-only: a forked worktree DB inherits main's conversations and trigger
  // rows, and must not type into main's agents (as self-compact.send).
  run: async ({ event }) => {
    if (!event) return;
    if (!isMain()) return;
    if (isAgentBusy(event.status)) return;
    await backstopStop(event.conversationId, productionPorts);
  },
});
