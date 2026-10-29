import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { isAgentBusy } from "@plugins/conversations/core";
import { submitTurn } from "@plugins/conversations/server";
import { sendCompaction, type CompactionPorts } from "./compaction";

const productionPorts: CompactionPorts = {
  async conversation(id) {
    const c = await getConversation(id);
    return c === null
      ? null
      : { busy: isAgentBusy(c.status), waitingFor: c.waitingFor };
  },
  async submit(conversationId, turn) {
    const out = await submitTurn(conversationId, {
      ...turn,
      typedText: turn.text,
    });
    if (out.kind === "not-found")
      throw new Error(`compaction: conversation ${conversationId} not found`);
  },
};

export const sendCompactionJob = defineJob({
  name: "self-compact.send",
  description:
    "When an agent that asked to compact its context stops being busy, sends it /compact with what it said to keep, then what it said to continue with.",
  hold: "instant",
  input: z.object({}),
  // Two runs for one conversation at once send the same two turns (their ids
  // are minted with the request), which the ledger no-ops the second time.
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      status: ConversationStatusSchema,
    })
    .passthrough(),
  // Main-only: a forked worktree DB inherits main's pending requests and
  // trigger rows, and must not type into main's agents (as watch.deliver).
  run: async ({ event }) => {
    if (!event) return;
    if (!isMain()) return;
    if (isAgentBusy(event.status)) return;
    await sendCompaction(event.conversationId, productionPorts);
  },
});
