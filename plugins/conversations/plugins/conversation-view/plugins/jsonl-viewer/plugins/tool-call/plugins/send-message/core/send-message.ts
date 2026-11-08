import { z } from "zod";

/**
 * What a `SendMessage` call asked for. `message` is prose, or one of the
 * harness's legacy protocol replies (`{ type: "shutdown_response", … }`); it
 * may be empty when the call only subscribes to an idle notice.
 */
const SendMessageInputSchema = z.object({
  to: z.string(),
  message: z
    .union([
      z.string(),
      z.looseObject({
        type: z.string(),
        approve: z.boolean().optional(),
        reason: z.string().optional(),
        feedback: z.string().optional(),
      }),
    ])
    .optional(),
  summary: z.string().optional(),
  notify_when_idle: z.boolean().optional(),
});

/** The body the harness answers a delivered send with. */
const SendMessageResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  /** Set when the send woke a stopped sub-agent: a new turn under this id. */
  resumedAgentId: z.string().optional(),
  /** The agent the send resolved to — for an in-process sub-agent, its own id. */
  pin: z.object({ id: z.string(), name: z.string() }).optional(),
});

/** A sub-agent's own id as the harness mints it (`a` + 16 hex digits). */
const AGENT_ID = /^a[0-9a-f]{16}$/;

/** The recipient the call named, as a reader wants it said. */
export type Recipient =
  /** The parent conversation, from a background sub-agent. */
  | { kind: "main" }
  /** A sub-agent named by its raw id (shown shortened, as the harness does). */
  | { kind: "agent-id"; agentId: string; short: string }
  /** A name: a teammate, a sub-agent, or another session (its `[ref]` dropped). */
  | { kind: "name"; name: string };

export type MessageBody =
  | { kind: "text"; text: string }
  /** A legacy protocol reply, in words (`Shutdown approved`). */
  | { kind: "protocol"; headline: string; detail: string | undefined }
  /** No message: the call only asked to be told when the recipient goes idle. */
  | { kind: "none" };

/** How the send went, from its result. */
export type Delivery =
  | { kind: "pending" }
  | { kind: "resumed"; agentId: string }
  | { kind: "queued" }
  /** Delivered, in the harness's own words (a cross-session send, …). */
  | { kind: "sent"; text: string | undefined }
  | { kind: "failed"; reason: string };

export interface SendMessageCall {
  recipient: Recipient;
  body: MessageBody;
  /** The caller's own 5–10 word label for the row, else the message's first line. */
  headline: string;
  notifyWhenIdle: boolean;
  delivery: Delivery;
  /** The sub-agent the send reached, when it reached one: the pane to open. */
  agentId: string | undefined;
}

function recipientOf(to: string): Recipient {
  const trimmed = to.trim();
  if (trimmed === "main") return { kind: "main" };
  if (AGENT_ID.test(trimmed)) {
    return { kind: "agent-id", agentId: trimmed, short: trimmed.slice(0, 7) };
  }
  return { kind: "name", name: trimmed.replace(/\s*\[[^\]]*\]$/, "") };
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function bodyOf(
  message: z.infer<typeof SendMessageInputSchema>["message"],
): MessageBody {
  if (message === undefined || message === "") return { kind: "none" };
  if (typeof message === "string") return { kind: "text", text: message };
  const verdict =
    message.approve === undefined
      ? ""
      : message.approve
        ? " · approved"
        : " · rejected";
  return {
    kind: "protocol",
    headline: sentence(message.type.replaceAll("_", " ")) + verdict,
    detail: message.feedback ?? message.reason,
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

function deliveryOf(
  result: { content: string; isError?: boolean } | undefined,
): { delivery: Delivery; reached: string | undefined } {
  if (result === undefined) {
    return { delivery: { kind: "pending" }, reached: undefined };
  }
  if (result.isError === true) {
    return {
      delivery: { kind: "failed", reason: result.content },
      reached: undefined,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Prose: a cross-session receipt the harness words itself.
    return {
      delivery: { kind: "sent", text: result.content },
      reached: undefined,
    };
  }
  const body = SendMessageResultSchema.safeParse(parsed);
  if (!body.success) {
    return {
      delivery: { kind: "sent", text: result.content },
      reached: undefined,
    };
  }
  const { success, message, resumedAgentId, pin } = body.data;
  if (!success) {
    return {
      delivery: { kind: "failed", reason: message ?? result.content },
      reached: undefined,
    };
  }
  const reached = resumedAgentId ?? pin?.id;
  if (resumedAgentId !== undefined) {
    return { delivery: { kind: "resumed", agentId: resumedAgentId }, reached };
  }
  if (message?.startsWith("Message queued") === true) {
    return { delivery: { kind: "queued" }, reached };
  }
  return { delivery: { kind: "sent", text: message }, reached };
}

/**
 * A `SendMessage` tool call, read for its row: who it went to, what it said,
 * and whether it was queued, woke a stopped sub-agent, or failed.
 *
 * Throws when the input is not a `SendMessage` input at all — the row then
 * shows the dispatch's own failure rather than a card claiming a recipient.
 */
export function readSendMessage(
  input: unknown,
  result: { content: string; isError?: boolean } | undefined,
): SendMessageCall {
  const parsed = SendMessageInputSchema.parse(input);
  const recipient = recipientOf(parsed.to);
  const body = bodyOf(parsed.message);
  const { delivery, reached } = deliveryOf(result);
  const summary = parsed.summary?.trim();
  const headline =
    summary !== undefined && summary !== ""
      ? summary
      : body.kind === "text"
        ? firstLine(body.text)
        : body.kind === "protocol"
          ? body.headline
          : "Notify when idle";
  return {
    recipient,
    body,
    headline,
    notifyWhenIdle: parsed.notify_when_idle === true,
    delivery,
    agentId:
      reached ??
      (recipient.kind === "agent-id" ? recipient.agentId : undefined),
  };
}
