import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { EventRow } from "./event-row";
import type { ContextMember } from "./hosted-context";

const layersIcon = symbol("layers");

/**
 * A run of harness-injected context behind one thin rule —
 * `Session context · 7 items` — in the compaction divider's visual language.
 * Closed by default. Opened, every member is its own full `EventRow`: its
 * renderer, its row actions, and for an unhandled subtype the fallback card
 * with its investigate action.
 */
export function ContextFold({
  label,
  members,
}: {
  label: string;
  members: readonly ContextMember[];
}) {
  return (
    <Collapsible className="px-xs py-xs">
      <CollapsibleTrigger className="text-caption text-muted-foreground hover:text-foreground">
        <Stack
          as="span"
          direction="row"
          gap="sm"
          align="center"
          className={growClass()}
        >
          <Separator aria-hidden className={growClass()} />
          <Stack as="span" direction="row" gap="xs" align="center">
            <Icon icon={layersIcon} className="size-3.5" />
            {label}
            <span className="tabular-nums">
              · {members.length} {members.length === 1 ? "item" : "items"}
            </span>
            <CollapsibleChevron className="size-3" />
          </Stack>
          <Separator aria-hidden className={growClass()} />
        </Stack>
      </CollapsibleTrigger>
      {/* The fold hangs off the rule: a left hairline marks its rows as the run's. */}
      <CollapsibleContent className="pt-sm pl-xs">
        <Stack gap="sm" className="border-l border-border pl-md">
          {members.map((m) => (
            <EventRow key={m.index} event={m.event} index={m.index} />
          ))}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}
