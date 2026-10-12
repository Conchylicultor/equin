import { Markdown } from "@plugins/primitives/plugins/markdown/web";

/**
 * An item's words — a checklist line, a table cell — as inline markdown, so the
 * `**bold**` or `code` the agent wrote reads as it does in the rest of the
 * reply, on every surface that draws the item (the reply, the sent message).
 */
export function GoItemText({ text }: { text: string }) {
  return <Markdown inline>{text}</Markdown>;
}
