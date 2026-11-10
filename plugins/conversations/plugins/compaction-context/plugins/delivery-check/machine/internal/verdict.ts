// Did the agent get the compaction context whole? Read off the transcript
// lines written since it was handed out — what the CLI really put in the
// agent's context, not what our copy of its cap predicts.

/** What the transcript says became of one compaction context. */
export type DeliveryVerdict =
  /** Nothing decisive written yet: no SessionStart context, no answer. */
  | { kind: "pending" }
  /** A SessionStart context item is the sent text, character for character. */
  | { kind: "delivered" }
  | {
      kind: "cut";
      /**
       * What the agent got instead: the CLI's `<persisted-output>` preview,
       * some other text, or no SessionStart context at all before it answered.
       */
      received: "preview" | "altered" | "none";
      /** The length of what it got (0 for `none`). */
      receivedChars: number;
    };

const PERSISTED_PREFIX = "<persisted-output>";

type Line = Readonly<Record<string, unknown>>;

function atOrAfter(line: Line, since: Date): boolean {
  const at =
    typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  return !Number.isNaN(at) && at >= since.getTime();
}

/** The SessionStart `additionalContext` items of a hook attachment line, or null. */
function sessionStartContexts(line: Line): string[] | null {
  if (line.type !== "attachment") return null;
  const att = line.attachment;
  if (typeof att !== "object" || att === null) return null;
  const a = att as Record<string, unknown>;
  if (a.type !== "hook_additional_context" || a.hookEvent !== "SessionStart") {
    return null;
  }
  return Array.isArray(a.content)
    ? a.content.filter((c): c is string => typeof c === "string")
    : [];
}

/**
 * Judge one send against the transcript lines (oldest first). Decides at the
 * first SessionStart context written since `sentAt` — the CLI writes every
 * SessionStart hook's context there, right after the hooks ran — or, if none
 * comes, at the agent's first answer since. Fails closed: anything but the
 * exact text is a cut.
 */
export function judgeDelivery(
  lines: readonly Line[],
  send: { context: string; sentAt: Date },
): DeliveryVerdict {
  for (const line of lines) {
    if (!atOrAfter(line, send.sentAt)) continue;
    const contexts = sessionStartContexts(line);
    if (contexts !== null) {
      if (contexts.includes(send.context)) return { kind: "delivered" };
      const preview = contexts.find((c) => c.startsWith(PERSISTED_PREFIX));
      const got = preview ?? contexts.join("\n\n");
      return {
        kind: "cut",
        received: preview !== undefined ? "preview" : "altered",
        receivedChars: got.length,
      };
    }
    if (line.type === "assistant") {
      return { kind: "cut", received: "none", receivedChars: 0 };
    }
  }
  return { kind: "pending" };
}
