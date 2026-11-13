import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { db } from "@plugins/database/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  granted,
  grantOf,
  mandateOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  ResumeBlockedError,
  resumeConversation,
  submitTurn,
} from "@plugins/conversations/server";
import { messageTree } from "@plugins/tasks/plugins/orchestration/plugins/message/plugins/capability/core";
import {
  agentOf,
  isUnder,
  renderAgents,
  SETTLED_SHOWN,
  treeAgents,
} from "./agents";
import { renderOutcome, sendAgentMessage, type MessagePorts } from "./send";

/** The ports a send from `fromConversationId` runs on. */
function productionPorts(fromConversationId: string): MessagePorts {
  return {
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
      // `sendAgentMessage` resumed a stopped target before this: only a target
      // that stopped again in between is still one.
      if (out.kind === "stopped")
        throw new Error(
          `message: conversation ${conversationId} is ${out.status}`,
        );
    },
    async mayReopen(taskId) {
      if ((await grantOf(messageTree, fromConversationId)) === null)
        return {
          ok: false,
          message:
            "only a supervisor reopens a closed agent, on its own tree. Tell whoever supervises it, or file a task.",
        };
      const self = await getConversation(fromConversationId);
      const mandate = self === null ? null : await mandateOf(self.taskId);
      if (
        mandate === null ||
        mandate.kind === "none" ||
        !(await isUnder(db, taskId, mandate.rootTaskId))
      )
        return {
          ok: false,
          message: `${taskId} is not in your task tree (see \`list_agents\`), and you reopen only your own tree's agents.`,
        };
      return { ok: true };
    },
  };
}

export const listAgentsTool = Mcp.tool({
  name: "list_agents",
  when: granted(messageTree),
  description: `List the agents of your task tree: for every task an agent ran on, its latest conversation and how it stands (starting, working, idle, waiting on the user, stopped, closed), your own marked. Settled agents (task done or dropped, or agent closed) are capped to the ${SETTLED_SHOWN} started last, the rest counted; pass \`all: true\` for every one. Read-only. Message one with \`message_agent\`.`,
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe(
        `List every settled agent too, not only the ${SETTLED_SHOWN} started last.`,
      ),
  },
  async handler({ all }, { conversationId }) {
    const tree = await treeAgents(conversationId);
    const text =
      tree.kind === "no-tree"
        ? "Your conversation has no task tree."
        : renderAgents(tree.agents, { all: all === true });
    return { content: [{ type: "text", text }] };
  },
});

export const messageAgentTool = Mcp.tool({
  name: "message_agent",
  description: `Send a message to another agent — a reply to its report, a correction, a question, "push it", "redo X". It goes in now: a working agent reads it at its next step, an idle one starts on it, a stopped one is resumed first. One that has closed is refused (it ended its own work — often just before your message); its supervisor may pass \`reopen: true\` to resume it with the message, on a task of its own tree only. It does not wait for an answer: the agent answers the way it already reports back.

\`to\` is a task id (its latest conversation) or a conversation id (its task's latest conversation) — any task, not only your tree's.`,
  inputSchema: {
    to: z
      .string()
      .min(1)
      .describe("The task id or conversation id of the agent to message."),
    text: z.string().min(1).describe("What to tell it."),
    reopen: z
      .boolean()
      .optional()
      .describe(
        "Supervisors only, on their own tree: resume an agent that has closed, to give it more work. Without it, a closed agent is not messaged.",
      ),
  },
  async handler({ to, text, reopen }, { conversationId }) {
    const ref = to.trim();
    const self = await getConversation(conversationId);
    const [target, sender] = await Promise.all([
      agentOf(db, ref, conversationId),
      self === null ? null : agentOf(db, self.taskId, conversationId),
    ]);
    const outcome = await sendAgentMessage(
      {
        fromConversationId: conversationId,
        sender,
        to: ref,
        target,
        text,
        reopen: reopen === true,
      },
      productionPorts(conversationId),
    );
    return { content: [{ type: "text", text: renderOutcome(outcome) }] };
  },
});
