import { unwrapEventTurn } from "@plugins/conversations/plugins/turn-ledger/core";
import { isInterruptContent } from "./interrupt";
import { unwrapPastedContent } from "./pasted-content";

/**
 * The text of a transcript line the user typed, or null when the line is
 * anything else: a tool result, a harness-injected turn (`isMeta`), an
 * interrupt sentinel, a delivered background-task report, an `event` turn the
 * app delivered (the turn ledger's `<equin-event>` envelope), or the summary a
 * context compaction writes (`isCompactSummary`).
 *
 * One definition on purpose. The parser stamps a `user-text` row with its line
 * `uuid` exactly when this returns text, and a rewind accepts a cut point
 * exactly when this returns text — so every row that offers "Rewind to here"
 * names a line the cut will take.
 */
export function userPromptText(line: Record<string, unknown>): string | null {
  if (line.type !== "user" || line.isMeta === true) return null;
  if (line.isCompactSummary === true) return null;
  const msg = line.message as { role?: unknown; content?: unknown } | undefined;
  if (msg?.role !== "user") return null;
  const origin = line.origin as { kind?: unknown } | undefined;
  if (origin?.kind === "task-notification") return null;

  let text: string;
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const blocks = (msg.content as unknown[]).filter(
      (b): b is { type?: unknown; text?: unknown } =>
        typeof b === "object" && b !== null,
    );
    if (blocks.some((b) => b.type === "tool_result")) return null;
    text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  } else {
    return null;
  }
  // The `<pasted_content>` wrapper is the terminal's, not the person's — a
  // turn they pasted says the same thing as one they typed.
  text = unwrapPastedContent(text);
  if (!text.trim() || isInterruptContent(text)) return null;
  if (unwrapEventTurn(text) !== null) return null;
  return text;
}

/**
 * The tool-result text of a transcript line that answers an AskUserQuestion —
 * the user's answer, delivered as the tool's real result — or null when the
 * line is anything else. It is the user's own message as much as a typed turn
 * is, so it is the other line a rewind can cut at ("Change answers").
 *
 * The answer is recognised by the line's structured `toolUseResult` (the
 * question record, `questions` + `answers`), never by the result's prose. The
 * result the CLI fills in when a session ended mid-question
 * (`toolDenialKind: "interrupted"`) is no answer.
 *
 * One definition on purpose: the parser stamps a call's result with its line
 * `uuid` (`answerUuid`) exactly when this returns text.
 */
export function questionAnswerText(
  line: Record<string, unknown>,
): string | null {
  if (line.type !== "user" || line.isMeta === true) return null;
  if (line.toolDenialKind === "interrupted") return null;
  const record = line.toolUseResult;
  if (typeof record !== "object" || record === null) return null;
  if (!("questions" in record) || !("answers" in record)) return null;
  const msg = line.message as { content?: unknown } | undefined;
  if (!Array.isArray(msg?.content)) return null;
  const results = (msg.content as unknown[]).filter(
    (b): b is { type: "tool_result"; content?: unknown } =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result",
  );
  if (results.length !== 1) return null;
  const content = results[0]!.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("");
}
