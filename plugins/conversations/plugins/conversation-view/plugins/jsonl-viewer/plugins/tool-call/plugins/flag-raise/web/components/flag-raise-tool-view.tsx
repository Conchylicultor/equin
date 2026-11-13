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
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import type React from "react";

const flagIcon = symbol("flag");

const flagIconClass = cn("size-4 text-warning", rigidClass());

/**
 * One item as a transcript holds it: `{ category, text, detail? }`
 * (push-and-exit's `FlagItem`), or a bare sentence in a transcript written
 * before items carried their own category and detail.
 */
const FlagRaiseItemSchema = z.union([
  z.string(),
  z.object({
    category: z.string().optional(),
    text: z.string(),
    detail: z.string().optional(),
  }),
]);
type FlagRaiseItem = z.infer<typeof FlagRaiseItemSchema>;

/**
 * `flag_raise`'s input, as its card draws it: the items the user acts on,
 * each with its own folded detail, and the folded notes (push-and-exit's
 * `Flag`) — or, in a transcript written before the split, one free-text
 * `reason`, drawn as before. Not the tool's own schema: a transcript keeps
 * whatever the agent sent, so no length bound is checked here.
 */
export const FlagRaiseInputSchema = z.union([
  z.object({
    items: z.array(FlagRaiseItemSchema),
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

type NormalizedItem = { category?: string; text: string; detail?: string };

/** What the user must act on: one plain sentence per item. */
function FlagItems({ items }: { items: FlagRaiseItem[] }) {
  const normalized: NormalizedItem[] = items.map((item) =>
    typeof item === "string" ? { text: item } : item,
  );
  return (
    <Stack gap="xs" className={fillClasses("x")}>
      {normalized.map((item, i) => (
        <FlagItem key={i} item={item} />
      ))}
    </Stack>
  );
}

/**
 * One item: its category chip and sentence — and, when the agent gave it a
 * detail, that detail folded under it, unfolded by clicking the item.
 */
function FlagItem({ item }: { item: NormalizedItem }) {
  const { open, triggerProps, contentProps } = useCollapsible();
  const line = (chevron: React.ReactNode) => (
    <Stack direction="row" gap="xs" align="start">
      {item.category ? (
        <FirstLine variant="body">
          <Badge variant="warning" className={rigidClass()}>
            {item.category}
          </Badge>
        </FirstLine>
      ) : null}
      <Text as="p" variant="body" className={fillClasses("x")}>
        {item.text}
      </Text>
      {chevron}
    </Stack>
  );
  if (!item.detail) return line(null);
  return (
    <div>
      <button
        {...triggerProps}
        className="block w-full rounded-sm text-left hover:bg-warning/10"
      >
        {line(
          <FirstLine variant="body">
            <CollapsibleChevron
              open={open}
              className={cn("size-3.5 text-muted-foreground", rigidClass())}
            />
          </FirstLine>,
        )}
      </button>
      <FoldMotion {...contentProps}>
        <Text
          as="p"
          variant="caption"
          tone="muted"
          className="whitespace-pre-wrap pt-xs"
        >
          {item.detail}
        </Text>
      </FoldMotion>
    </div>
  );
}
