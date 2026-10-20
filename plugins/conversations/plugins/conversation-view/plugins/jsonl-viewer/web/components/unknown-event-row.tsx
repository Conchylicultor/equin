/**
 * Default fallback for the `JsonlViewer.EventRenderer` dispatch slot: the raw
 * payload in a collapsible card, for any event kind no plugin renders — and for
 * `kind: "unknown"`, the parser's own fallback, which used to be a separate
 * contributed renderer saying the same thing one layer down.
 *
 * No `trailing` affordance: `CollapsibleCard` hosts `<EventRowActions/>`, and the
 * investigate action contributes itself to every row whose nearest dispatch fell
 * back. Hand-placing one here would double-render it.
 *
 * MUST stay a hoisted `function` declaration — `../slots` imports this module at
 * module-eval time to build the slot's `fallback`, and the chain continues into
 * `collapsible-card/web` → `row-actions/web`. A `const` arrow would TDZ-crash at
 * boot. Same shape as `pending-content-indicator.tsx`.
 */
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export function UnknownEventRow({ event }: { event: JsonlEvent }) {
  const isUnknownKind = event.kind === "unknown";
  return (
    <CollapsibleCard label={isUnknownKind ? event.type : event.kind}>
      <Text
        as="pre"
        variant="caption"
        tone="muted"
        className="whitespace-pre-wrap break-words font-mono"
      >
        {JSON.stringify(isUnknownKind ? event.raw : event, null, 2)}
      </Text>
    </CollapsibleCard>
  );
}
