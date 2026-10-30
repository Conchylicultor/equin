import type { TreeAgent, TreeAgents } from "./agents";

/** What sending a message does outside the tree read: ports, so a test drives
 * the policy with a fake agent. */
export interface MessagePorts {
  /** Bring a stopped (`gone` / `done`) conversation back. Returns a refusal's
   * message when the resume is blocked (its checkout reclaimed…); throws on
   * anything else. */
  resume(
    conversationId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Type one event turn into the conversation (held while it starts). */
  submit(conversationId: string, text: string): Promise<void>;
}

export type MessageOutcome =
  | {
      kind: "refused";
      reason:
        "no-tree" | "not-in-tree" | "self" | "no-agent" | "resume-blocked";
      message: string;
    }
  | {
      kind: "sent";
      conversationId: string;
      /** How the agent stood when the message went in. */
      was: NonNullable<TreeAgent["conversation"]>;
      resumed: boolean;
    };

/** The turn the target reads: who wrote, then what they wrote. */
export function messageText(
  sender: TreeAgent | undefined,
  fromConversationId: string,
  text: string,
): string {
  const who =
    sender === undefined
      ? `the agent of ${fromConversationId}`
      : `the agent on ${sender.taskId} "${sender.title}" (${fromConversationId})`;
  return `Message from ${who}:\n\n${text}`;
}

/**
 * Send `text` from `fromConversationId` to the agent of `to` — a task id (its
 * latest conversation) or a conversation id — in the sender's tree. Typed now,
 * as a person's turn would be: a busy agent reads it at its next step. A
 * stopped one is resumed first, the message held until it is up.
 */
export async function sendAgentMessage(
  tree: TreeAgents,
  fromConversationId: string,
  to: string,
  text: string,
  ports: MessagePorts,
): Promise<MessageOutcome> {
  if (tree.kind === "no-tree")
    return {
      kind: "refused",
      reason: "no-tree",
      message: "Your conversation has no task tree to message into.",
    };
  const target = tree.agents.find(
    (a) => a.taskId === to || a.conversation?.id === to,
  );
  if (target === undefined)
    return {
      kind: "refused",
      reason: "not-in-tree",
      message: `${to} is not a task or conversation of your tree (see \`list_agents\`).`,
    };
  if (target.conversation === null)
    return {
      kind: "refused",
      reason: "no-agent",
      message: `No agent has run on ${target.taskId} yet: there is nobody to message. Start it, or put what it should know in a task.`,
    };
  if (target.self)
    return {
      kind: "refused",
      reason: "self",
      message: "That is your own conversation.",
    };
  const was = target.conversation;
  const stopped = was.status === "gone" || was.status === "done";
  if (stopped) {
    const resumed = await ports.resume(was.id);
    if (!resumed.ok)
      return {
        kind: "refused",
        reason: "resume-blocked",
        message: `${was.id} is stopped and cannot be resumed: ${resumed.message}`,
      };
  }
  const sender = tree.agents.find((a) => a.self);
  await ports.submit(was.id, messageText(sender, fromConversationId, text));
  return { kind: "sent", conversationId: was.id, was, resumed: stopped };
}

/** `message_agent`'s answer. */
export function renderOutcome(outcome: MessageOutcome): string {
  if (outcome.kind === "refused") return `Not sent: ${outcome.message}`;
  const { conversationId, was } = outcome;
  if (outcome.resumed)
    return `Sent to ${conversationId}: it had stopped, so it is resuming, and the message is delivered once it is up.`;
  switch (was.status) {
    case "starting":
      return `Sent to ${conversationId}: it is starting, and the message is delivered once it is up.`;
    case "working":
      return `Sent to ${conversationId}: it is working, and reads the message at its next step.`;
    case "waiting":
    case "gone":
    case "done":
      return was.waitingFor !== null
        ? `Sent to ${conversationId}: it was waiting on the user, and takes your message instead.`
        : `Sent to ${conversationId}: it was idle, and starts on it now.`;
  }
}
