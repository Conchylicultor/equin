import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { EventRow } from "./event-row";
import type { ContextMember } from "./hosted-context";

const layersIcon = symbol("layers");

/**
 * A run of harness-injected context as one timeline row —
 * `Session context · 7 items` — like any other row: closed by default, and
 * opened, its members hang under it on the rail, each its own full
 * `EventRow` (its renderer, its row actions, and for an unhandled subtype the
 * fallback card with its investigate action).
 */
export function ContextFold({
  label,
  members,
}: {
  label: string;
  members: readonly ContextMember[];
}) {
  return (
    <CollapsibleCard
      icon={<Icon icon={layersIcon} className="size-3.5" />}
      label={label}
      summary={
        <span className="tabular-nums">
          {members.length} {members.length === 1 ? "item" : "items"}
        </span>
      }
    >
      <Stack gap="2xs">
        {members.map((m) => (
          <EventRow key={m.index} event={m.event} index={m.index} />
        ))}
      </Stack>
    </CollapsibleCard>
  );
}
