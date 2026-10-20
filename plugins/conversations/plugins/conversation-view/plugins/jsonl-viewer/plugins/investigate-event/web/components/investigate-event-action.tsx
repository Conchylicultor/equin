import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { useDispatchOutcome } from "@plugins/primitives/plugins/slot-render/web";
import { IMPROVEMENTS_CATEGORY_ID } from "@plugins/improve/core";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { rowActionClass } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

/**
 * One row action, gated entirely on the dispatch outcome: it renders iff the
 * nearest enclosing `.Dispatch` fell back — i.e. nothing handled this row. That
 * covers an unhandled event kind, an unhandled tool name, and an unhandled
 * attachment subtype today, and any fallback added later with zero wiring.
 *
 * The label is `outcome.key`, whatever the dispatch keyed on. Do NOT switch on
 * `event.kind` to recover a prettier one — that is exactly the per-fallback
 * coupling this action replaces; the raw identity stays visible in the card
 * label, the serialized event below, and the raw-json popover.
 */
export function InvestigateEventAction({ event }: { event: JsonlEvent }) {
  const outcome = useDispatchOutcome();
  const conversationId = useJsonlConversationId();
  // Hooks first, guard second: the gate is a render decision, not a hook-order one.
  if (!outcome || outcome.matched) return null;

  const label = outcome.key;
  return (
    <LaunchAgentPopover
      draftKey={`add-renderer:${label}`}
      align="end"
      title="Add a renderer"
      description={`Nothing renders \`${label}\` yet, so this row falls back to raw JSON. Launch an agent to build a proper renderer for it.`}
      placeholder="Optional — what this row should show, and how…"
      trigger={
        <button
          className={rowActionClass()}
          title={`Add a renderer for ${label}`}
          aria-label="Launch agent to add a renderer"
          onClick={(e) => e.stopPropagation()}
        >
          <Icon icon={autoAwesomeIcon} className="size-3" />
        </button>
      }
      getRequest={(userText) => {
        const body = userText.trim();
        const prompt = [
          `## Implement a transcript renderer for \`${label}\``,
          "",
          `No plugin contributes a renderer for \`${label}\`, so the conversation`,
          "viewer dispatches it to a generic fallback that dumps raw JSON. Build the",
          "renderer so this row reads like the rest of the transcript.",
          "",
          `**Dispatch slot:** \`${outcome.slotId}\``,
          `**Dispatch key to match:** \`${outcome.key}\``,
          `**Source conversation:** \`${conversationId ?? "unknown"}\``,
          "",
          "Renderers are sub-plugins that contribute to that slot — read the sibling",
          "plugins next to the slot's owner for the exact contribution shape and the",
          "house card/row conventions, and follow the contributor rules in the",
          "jsonl-viewer `CLAUDE.md`. Design what a reader of this row actually needs",
          "surfaced; do not just pretty-print every field.",
          "",
          "One sample payload (inspect more via the row's raw-JSON action, and by",
          "querying other conversations — the shape may vary):",
          "",
          "```json",
          JSON.stringify(event, null, 2),
          "```",
          ...(body ? ["", "## What the user asked for", "", body] : []),
        ].join("\n");
        return { prompt, categoryId: IMPROVEMENTS_CATEGORY_ID };
      }}
    />
  );
}
