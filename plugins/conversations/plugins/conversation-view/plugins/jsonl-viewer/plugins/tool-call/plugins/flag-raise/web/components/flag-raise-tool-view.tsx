import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  FirstLine,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";

const flagIcon = symbol("flag");

const flagIconClass = cn("size-4 text-warning", rigidClass());

/**
 * `flag_raise`'s input, as its card draws it: the items the user acts on and
 * the folded details (push-and-exit's `Flag`) — or, in a transcript written
 * before the split, one free-text `reason`, drawn as before. Not the
 * tool's own schema: a transcript keeps whatever the agent sent, so no
 * length bound is checked here.
 */
export const FlagRaiseInputSchema = z.union([
  z.object({
    items: z.array(z.string()),
    details: z.string().optional(),
  }),
  z.object({ reason: z.string() }),
]);
type FlagRaiseInput = z.infer<typeof FlagRaiseInputSchema>;

export function FlagRaiseToolView({
  event,
  input,
}: ToolViewProps<FlagRaiseInput>) {
  return (
    <ToolCallCard event={event} summary="Flagged for review" defaultOpen>
      <Stack
        direction="row"
        gap="sm"
        align="start"
        className="rounded-md border border-warning/30 bg-warning/10 px-md py-sm"
      >
        <FirstLine variant="caption">
          <Icon icon={flagIcon} className={flagIconClass} />
        </FirstLine>
        {"items" in input ? (
          <FlagItems items={input.items} />
        ) : (
          <Text as="p" variant="caption" className="whitespace-pre-wrap">
            {input.reason}
          </Text>
        )}
      </Stack>
      {"items" in input && input.details ? (
        <Collapsible>
          <CollapsibleTrigger className="gap-xs text-muted-foreground">
            <CollapsibleChevron className="size-3.5" />
            <Text as="span" variant="caption">
              Details
            </Text>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Text
              as="p"
              variant="caption"
              tone="muted"
              className="whitespace-pre-wrap"
            >
              {input.details}
            </Text>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {event.result?.isError && (
        <Text as="p" variant="caption" className="text-destructive">
          {event.result.content}
        </Text>
      )}
    </ToolCallCard>
  );
}

/** What the user must act on: one plain sentence per item. */
function FlagItems({ items }: { items: string[] }) {
  if (items.length === 1) {
    return (
      <Text as="p" variant="body">
        {items[0]}
      </Text>
    );
  }
  return (
    <Stack as="ul" gap="xs" className="list-disc pl-md">
      {items.map((item, i) => (
        <Text as="li" variant="body" key={i}>
          {item}
        </Text>
      ))}
    </Stack>
  );
}
