import { isInterruptContent } from "./interrupt";
import { unwrapPastedContent } from "./pasted-content";

/**
 * The text of a transcript line the user typed, or null when the line is
 * anything else: a tool result, a harness-injected turn (`isMeta`), an
 * interrupt sentinel, a delivered background-task report, or the summary a
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
  return text;
}
