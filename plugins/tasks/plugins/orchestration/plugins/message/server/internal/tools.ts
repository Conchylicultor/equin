import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { granted } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  ResumeBlockedError,
  resumeConversation,
  submitTurn,
} from "@plugins/conversations/server";
import { messageTree } from "@plugins/tasks/plugins/orchestration/plugins/message/plugins/capability/core";
import { renderAgents, treeAgents } from "./agents";
import { renderOutcome, sendAgentMessage, type MessagePorts } from "./send";

const productionPorts: MessagePorts = {
  async resume(conversationId) {
    try {
      await resumeConversation(conversationId);
      return { ok: true };
    } catch (err) {
      if (err instanceof ResumeBlockedError)
        return { ok: false, message: err.message };
      throw err;
    }
  },
  async submit(conversationId, text) {
    const out = await submitTurn(conversationId, {
      kind: "event",
      text,
      typedText: text,
    });
    if (out.kind === "not-found")
      throw new Error(`message: conversation ${conversationId} not found`);
  },
};

export const listAgentsTool = Mcp.tool({
  name: "list_agents",
  when: granted(messageTree),
  description:
    "List the agents of your task tree: for every task an agent ran on, its latest conversation and how it stands (starting, working, idle, waiting on the user, stopped, closed), your own marked. Read-only. Message one with `message_agent`.",
  inputSchema: {},
  async handler(_input, { conversationId }) {
    const tree = await treeAgents(conversationId);
    const text =
      tree.kind === "no-tree"
        ? "Your conversation has no task tree."
        : renderAgents(tree.agents);
    return { content: [{ type: "text", text }] };
  },
});

export const messageAgentTool = Mcp.tool({
  name: "message_agent",
  when: granted(messageTree),
  description: `Send a message to the agent of a task in your tree — a reply to its report, a correction, "push it", "redo X". It goes in now: a working agent reads it at its next step, an idle one starts on it, a stopped one is resumed first. It does not wait for an answer: the agent answers the way it already reports back to you.

\`to\` is a task id (its latest conversation) or a conversation id, as \`list_agents\` and your event turns name them.`,
  inputSchema: {
    to: z
      .string()
      .min(1)
      .describe("The task id or conversation id of the agent to message."),
    text: z.string().min(1).describe("What to tell it."),
  },
  async handler({ to, text }, { conversationId }) {
    const outcome = await sendAgentMessage(
      await treeAgents(conversationId),
      conversationId,
      to.trim(),
      text,
      productionPorts,
    );
    return { content: [{ type: "text", text: renderOutcome(outcome) }] };
  },
});
