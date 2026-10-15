import type { ReactNode } from "react";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export interface FieldsCardField {
  /** Field name, rendered as the muted `key:` prefix. */
  key: string;
  /** Field content, rendered verbatim (preserves whitespace). */
  value: string;
}

/**
 * The shared appearance for "a headline + a one-line summary preview + a
 * fold-out list of `key: value` fields" — the structure both a queued
 * `<task-notification>` block (StructuredTagCard) and a native task-notification
 * event (TaskNotificationRow) independently re-implemented on top of
 * {@link CollapsibleCard}, each with the same bug: the summary jammed into the
 * card's rigid `label` zone never truncated.
 *
 * Here the summary rides the card's purpose-built `summary` slot, so the header
 * collapses to a single ellipsized preview — and it is ALSO rendered in full at
 * the top of the body, so nothing is lost when the card is open. Every field the
 * payload carries (including ones added in a future format) folds behind the
 * chevron, full and untruncated.
 */
export function FieldsCard({
  icon,
  label,
  note,
  summary,
  fields,
  mono,
  aside,
  trailing,
  error,
  defaultOpen,
}: {
  /** Leading icon — raw element, sized by the caller (e.g. a StatusDot). */
  icon?: ReactNode;
  /** Headline content (a humanized tag name, a status label). */
  label: ReactNode;
  /** Muted middot-led suffix after the label naming what it counted (`· 3 calls`). */
  note?: ReactNode;
  /** One-line summary preview. Truncates in the header; shown full in the body. */
  summary?: string;
  /** The fold-out fields. Pass everything EXCEPT the summary (it is rendered
   *  separately so it never appears twice). */
  fields: FieldsCardField[];
  /** Render field values (and the summary) in a monospace font. */
  mono?: boolean;
  /** Interactive sibling after the label (e.g. a FilePath). */
  aside?: ReactNode;
  /** Far-right header sibling. */
  trailing?: ReactNode;
  /** Destructive chrome override. */
  error?: boolean;
  /** Open on first render. */
  defaultOpen?: boolean;
}) {
  return (
    <CollapsibleCard
      icon={icon}
      label={label}
      note={note}
      summary={summary}
      aside={aside}
      trailing={trailing}
      error={error}
      defaultOpen={defaultOpen}
    >
      <Stack gap="xs">
        {summary != null && summary !== "" && (
          <Text
            as="div"
            variant="caption"
            className={cn(
              "whitespace-pre-wrap break-words text-foreground",
              mono && "font-mono",
            )}
          >
            {summary}
          </Text>
        )}
        {fields.map((f) => (
          <Text
            key={f.key}
            as="div"
            variant="caption"
            className={cn(
              "whitespace-pre-wrap break-words text-muted-foreground",
              mono && "font-mono",
            )}
          >
            <span className="text-muted-foreground/60">{f.key}: </span>
            {f.value}
          </Text>
        ))}
      </Stack>
    </CollapsibleCard>
  );
}
