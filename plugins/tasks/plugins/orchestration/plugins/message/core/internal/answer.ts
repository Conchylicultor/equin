/**
 * The text of `message_agent`'s answer, written by the tool and read back by
 * the transcript viewer, from this one place so the two cannot drift. A text
 * the reader does not recognise stays text: transcripts written before a
 * change still show.
 */

/** How a sent message lands, each with the sentence the agent reads. */
export const DELIVERIES = {
  resuming:
    "it had stopped, so it is resuming, and the message is delivered once it is up.",
  starting: "it is starting, and the message is delivered once it is up.",
  working: "it is working, and reads the message at its next step.",
  stuck:
    "it is stuck — it holds a turn it never started — so the message queues behind that turn and is read only once the agent moves again.",
  "was-waiting": "it was waiting on the user, and takes your message instead.",
  "was-idle": "it was idle, and starts on it now.",
} as const;

export type Delivery = keyof typeof DELIVERIES;

export type MessageAnswer =
  | { kind: "sent"; conversationId: string; delivery: Delivery }
  | { kind: "not-sent"; message: string };

export function formatMessageAnswer(answer: MessageAnswer): string {
  return answer.kind === "not-sent"
    ? `Not sent: ${answer.message}`
    : `Sent to ${answer.conversationId}: ${DELIVERIES[answer.delivery]}`;
}

export type ReadMessageAnswer = MessageAnswer | { kind: "text"; text: string };

const SENTENCE_DELIVERY = new Map<string, Delivery>(
  Object.entries(DELIVERIES).map(([d, s]) => [s, d as Delivery]),
);

export function readMessageAnswer(text: string): ReadMessageAnswer {
  const notSent = /^Not sent: ([\s\S]*)$/.exec(text);
  if (notSent) return { kind: "not-sent", message: notSent[1]! };
  const sent = /^Sent to (\S+): ([\s\S]*)$/.exec(text);
  const delivery = sent ? SENTENCE_DELIVERY.get(sent[2]!) : undefined;
  if (!sent || delivery === undefined) return { kind: "text", text };
  return { kind: "sent", conversationId: sent[1]!, delivery };
}
