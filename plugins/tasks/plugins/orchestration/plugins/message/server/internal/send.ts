import { STUCK_TURN_WAITING_FOR } from "@plugins/conversations/core";
import type { TreeAgent } from "./agents";
import { formatMessageAnswer, type Delivery } from "../../core";

/** What sending a message does outside the target read: ports, so a test
 * drives the policy with a fake agent. */
export interface MessagePorts {
  /** Bring a stopped (`gone`, or `done` when reopening) conversation back. Returns a refusal's
   * message when the resume is blocked (its checkout reclaimed…); throws on
   * anything else. */
  resume(
    conversationId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Type one event turn into the conversation (held while it starts). */
  submit(conversationId: string, text: string): Promise<void>;
  /** Whether the sender may reopen the closed agent of `taskId`: only an
   * agent granted `message.tree`, and only on a task of its own mandate tree.
   * Asked only when a send needs it. */
  mayReopen(
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

export type MessageOutcome =
  | {
      kind: "refused";
      reason:
        | "not-found"
        | "self"
        | "no-agent"
        | "closed"
        | "reopen-denied"
        | "resume-blocked";
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
  sender: TreeAgent | null,
  fromConversationId: string,
  text: string,
): string {
  const who =
    sender === null
      ? `the agent of ${fromConversationId}`
      : `the agent on ${sender.taskId} "${sender.title}" (${fromConversationId})`;
  return `Message from ${who}:\n\n${text}`;
}

export interface MessageRequest {
  fromConversationId: string;
  /** The sender's own task and title, for the message's header. */
  sender: TreeAgent | null;
  /** What the sender wrote in `to`. */
  to: string;
  /** The agent `to` names (`agentOf`), or `null` when it names nothing. */
  target: TreeAgent | null;
  text: string;
  reopen?: boolean;
}

/**
 * Send `text` from `fromConversationId` to the agent `to` names — a task id
 * (its latest conversation) or a conversation id (its task's latest), any
 * task: every agent may message any other. Typed now, as a person's turn would
 * be: a busy agent reads it at its next step. A stopped (`gone`) one is resumed
 * first, the message held until it is up.
 *
 * A CLOSED (`done`) one is refused unless `reopen` says so — and reopening is
 * a supervisor's power over its own tree only (`ports.mayReopen`). Closing is
 * the agent's own deliberate end, and a sender usually writes from a view
 * taken before it — "landed, now close" arriving just after it closed.
 * Resuming it on that message reopened its settled task only for the agent to
 * close it again: a second `settled` for the same work, every time
 * (conv-1793313534-903j7g, three times in one tree).
 */
export async function sendAgentMessage(
  req: MessageRequest,
  ports: MessagePorts,
): Promise<MessageOutcome> {
  const { target, to } = req;
  if (target === null)
    return {
      kind: "refused",
      reason: "not-found",
      message: `${to} is neither a task id nor a conversation id.`,
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
  if (was.status === "done") {
    if (req.reopen !== true)
      return {
        kind: "refused",
        reason: "closed",
        message: `${was.id} has closed — its agent ended it — so nothing was sent and its task stays as it is. If it still has work to do, its supervisor can send again with \`reopen: true\` to resume it.`,
      };
    const may = await ports.mayReopen(target.taskId);
    if (!may.ok)
      return {
        kind: "refused",
        reason: "reopen-denied",
        message: `${was.id} has closed and you may not reopen it: ${may.message}`,
      };
  }
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
  await ports.submit(
    was.id,
    messageText(req.sender, req.fromConversationId, req.text),
  );
  return { kind: "sent", conversationId: was.id, was, resumed: stopped };
}

/** `message_agent`'s answer. */
export function renderOutcome(outcome: MessageOutcome): string {
  if (outcome.kind === "refused")
    return formatMessageAnswer({ kind: "not-sent", message: outcome.message });
  return formatMessageAnswer({
    kind: "sent",
    conversationId: outcome.conversationId,
    delivery: deliveryOf(outcome),
  });
}

function deliveryOf(
  outcome: Extract<MessageOutcome, { kind: "sent" }>,
): Delivery {
  if (outcome.resumed) return "resuming";
  const { was } = outcome;
  switch (was.status) {
    case "starting":
      return "starting";
    case "working":
      return "working";
    case "waiting":
    case "gone":
    case "done":
      if (was.waitingFor === STUCK_TURN_WAITING_FOR) return "stuck";
      return was.waitingFor !== null ? "was-waiting" : "was-idle";
  }
}
