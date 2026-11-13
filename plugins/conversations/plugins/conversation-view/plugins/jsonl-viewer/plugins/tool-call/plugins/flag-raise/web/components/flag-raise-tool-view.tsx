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
import { selectionIsCollapsed } from "@plugins/primitives/plugins/dom/plugins/dom-selection/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  FLAG_CATEGORIES,
  FlagCategorySchema,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/flag-categories/core";
import type React from "react";

const flagIcon = symbol("flag");

const flagIconClass = cn("size-4 text-warning", rigidClass());

/**
 * One item as a transcript holds it: `{ category, text, detail? }`
 * (push-and-exit's `FlagItem`), or a bare sentence in a transcript written
 * before items carried their own category and detail. The category is read
 * as any string: a transcript written while it was free-form keeps its own
 * word, drawn as a plain chip.
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
 * What the item asks of the user, as its chip: a known category in its own
 * label and colour; a free-form word from an older transcript as itself.
 */
// A label, not content: never part of a text selection over the item.
const chipClass = cn("select-none", rigidClass());

function CategoryChip({ category }: { category: string }) {
  const known = FlagCategorySchema.safeParse(category);
  if (!known.success)
    return (
      <Badge variant="muted" className={chipClass}>
        {category}
      </Badge>
    );
  const { label, badge } = FLAG_CATEGORIES[known.data];
  return (
    <Badge variant={badge} className={chipClass}>
      {label}
    </Badge>
  );
}

/**
 * One item: its category chip and sentence — and, when the agent gave it a
 * detail, that detail folded under it. The sentence stays selectable text (the
 * chip does not: it is a label, not content), so the row is not a `<button>`:
 * the chevron is the trigger, and a click anywhere else on the row toggles too —
 * unless it ended a drag that selected text.
 */
function FlagItem({ item }: { item: NormalizedItem }) {
  const { open, toggle, triggerProps, contentProps } = useCollapsible();
  const line = (chevron: React.ReactNode) => (
    <Stack direction="row" gap="xs" align="start">
      {item.category ? (
        <FirstLine variant="body">
          <CategoryChip category={item.category} />
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
      <div
        className="cursor-pointer rounded-sm hover:bg-warning/10"
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest("button")) return;
          if (!selectionIsCollapsed()) return;
          toggle();
        }}
      >
        {line(
          <FirstLine variant="body">
            <button
              {...triggerProps}
              aria-label={open ? "Hide detail" : "Show detail"}
              className={cn("rounded-sm", rigidClass())}
            >
              <CollapsibleChevron
                open={open}
                className="size-3.5 text-muted-foreground"
              />
            </button>
          </FirstLine>,
        )}
      </div>
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
