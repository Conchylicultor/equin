import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { MCP_SERVER_NAME } from "@plugins/infra/plugins/mcp/core";
import { isAgentBusy } from "@plugins/conversations/core";
import { Runtime, submitTurn } from "@plugins/conversations/server";
import { automaticTurnReadiness } from "@plugins/conversations/plugins/automatic-turn/server";
import { turnIdKind } from "@plugins/conversations/plugins/turn-ledger/core";
import { renderMandateInstructions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import {
  getConversation,
  listActiveConversations,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  noticeTurn,
  requestNotices,
  sendNotice,
  type NoticePorts,
} from "./notice";

const productionPorts: NoticePorts = {
  async running(conversationId) {
    const conversation = await getConversation(conversationId);
    if (!conversation) return false;
    return Runtime.get(conversation.runtime).isRunning(conversationId);
  },
  readiness: (conversationId, exec) =>
    automaticTurnReadiness(conversationId, { own: noticeTurn, exec }),
  mandateSection: (conversationId) => renderMandateInstructions(conversationId),
  async submit(conversationId, turn) {
    const out = await submitTurn(conversationId, {
      id: turnIdKind.parse(turn.id),
      kind: "event",
      text: turn.text,
      typedText: turn.text,
    });
    if (out.kind === "not-found")
      throw new Error(
        `mandate notice: conversation ${conversationId} not found`,
      );
  },
};

/**
 * On a mandate change: each live agent on the moved tasks reconnects the
 * equin MCP server (its tools follow at once), then is owed a notice carrying
 * the new `## Mandate` section — the instructions it read at its start are
 * not re-read. An agent this backend does not run (`not-running`: another
 * namespace's, or none) is skipped: its next start reads the new mandate.
 */
export const onMandateChangedJob = defineJob({
  name: "mandate-change-notice.on-change",
  description:
    "When tasks' effective mandate changes, makes each live agent on them reconnect the equin MCP server (its tools follow the new mandate) and sends it the new Mandate section as an automatic turn.",
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
    const reached = await Promise.all(
      live.map(async (c) => ({
        id: c.id,
        outcome: await Runtime.get(c.runtime).reconnectMcp(
          c.id,
          MCP_SERVER_NAME,
        ),
      })),
    );
    const owed = reached
      .filter((r) => r.outcome !== "not-running")
      .map((r) => r.id);
    await requestNotices(owed);
    for (const id of owed) await sendNotice(id, productionPorts);
  },
});

/** A held notice goes out once its agent can take an automatic turn. */
export const sendNoticeOnStatusJob = defineJob({
  name: "mandate-change-notice.send",
  description:
    "When an agent owed a mandate-change notice stops being busy (or stops waiting on the user), sends it the new Mandate section.",
  hold: "instant",
  input: z.object({}),
  // The turn id is minted with the request, so two runs at once send one turn.
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), status: ConversationStatusSchema })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (isAgentBusy(event.status)) return;
    await sendNotice(event.conversationId, productionPorts);
  },
});
