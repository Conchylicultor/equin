import type {
  HookRecord,
  JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";
import { refusalReason } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/refusal-format/core";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/** A hook that changed something the reader must see: anything but a pass. */
export function isLoudHook(h: HookRecord): boolean {
  return h.outcome !== "pass";
}

/** The PreToolUse hook that blocked the call — it never ran — if one did. */
export function blockingHook(event: ToolCallEvent): HookRecord | undefined {
  return event.hooks?.find(
    (h) => h.event === "PreToolUse" && h.outcome === "block",
  );
}

const firstParagraph = (text: string): string =>
  text
    .trim()
    .split(/\n\s*\n/)[0]
    ?.trim() ?? "";

/**
 * The one line a reader needs from a hook: for one of our guards, the
 * reason it gave (without the did-not-run banner aimed at the agent); for any
 * other hook, the first paragraph of what it said (or of its stderr).
 */
export function hookSummary(h: HookRecord): string | undefined {
  const said = h.text ?? h.stderr;
  if (!said) return undefined;
  return firstParagraph(refusalReason(said) ?? said) || undefined;
}
