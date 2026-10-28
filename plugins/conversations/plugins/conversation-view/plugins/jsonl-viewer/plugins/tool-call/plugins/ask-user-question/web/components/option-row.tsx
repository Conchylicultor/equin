import {
  CheckboxIndicator,
  RadioIndicator,
} from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

// One option row, shared by the interactive AnswerForm and the read-only
// answered view so the two can never drift apart.
//
// Selection is signalled on exactly two channels: the indicator (semantics) and
// the container outline (scannability). The container reserves its border in
// BOTH states (`border-transparent` when idle) so picking an option changes
// colour only — never geometry. A left-edge accent bar is deliberately not used:
// that idiom reads as "this line belongs to a thread" (blockquote / active nav
// item), not "you chose this", and every option here is card-shaped content
// (label + description + optional preview) that wants full-box containment.
//
// Hover lives on a separate channel from selected (muted fill vs primary ring),
// so hovering an already-selected row never reads as "about to deselect".

function Indicator({
  selected,
  multi,
  align,
}: {
  selected: boolean;
  multi: boolean;
  align: Align;
}) {
  // A checkbox (multi) and a radio (single) are semantic fixed shapes that must
  // stay a square / circle under every Shape preset. The selection-indicator
  // primitive owns those fixed shapes, so this just picks the right one.
  // The wrapper's top padding nudges the indicator to align with the first line
  // of multi-line label text — padding on a wrapper, since the indicator's own
  // box is its drawn shape and the ramp has no margin classes.
  return (
    <Stack gap="none" className={align === "start" ? "pt-2xs" : undefined}>
      {multi ? (
        <CheckboxIndicator checked={selected} />
      ) : (
        <RadioIndicator checked={selected} />
      )}
    </Stack>
  );
}

// "start" aligns the indicator to the first line of a multi-line text block;
// "center" centres it against a single-line control.
type Align = "start" | "center";

export function OptionRow({
  selected,
  multi,
  align = "start",
  dimmed = false,
  onClick,
  children,
}: {
  selected: boolean;
  multi: boolean;
  align?: Align;
  /** Fade an unpicked option once the question has been answered. */
  dimmed?: boolean;
  /** Omit to render a static (read-only) row rather than a button. */
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const interactive = onClick != null;
  return (
    <Stack
      as={interactive ? "button" : "div"}
      direction="row"
      gap="sm"
      align={align}
      onClick={onClick}
      className={cn(
        "w-full rounded-md border px-sm py-xs text-left transition-colors",
        selected
          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/30"
          : "border-transparent",
        !selected && interactive && "hover:bg-muted/50",
        !selected && dimmed && "opacity-60",
      )}
    >
      <Indicator selected={selected} multi={multi} align={align} />
      {/* Fill owns the min-w-0/flex-1 pair so the body absorbs slack and its
          <Text> leaves can wrap/truncate without squeezing the indicator. */}
      <Fill className="select-text">{children}</Fill>
    </Stack>
  );
}

/**
 * A free-standing field laid out like an option row — same box, same leading
 * column (an icon where the indicator would be) — so its control lines up with
 * the "Other…" field above it. Not a choice: it never shows a selection.
 */
export function FieldRow({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Stack
      direction="row"
      gap="sm"
      align="start"
      className="w-full rounded-md border border-transparent px-sm py-xs"
    >
      {/* pt-xs centres the icon on the field's first line of text. */}
      <Stack gap="none" className="pt-xs text-muted-foreground">
        {icon}
      </Stack>
      <Fill>{children}</Fill>
    </Stack>
  );
}

export function OptionBody({
  label,
  description,
  preview,
}: {
  label: string;
  description: string;
  preview?: string;
}) {
  return (
    <>
      <Text as="p" variant="caption" className="font-medium">
        {label}
      </Text>
      <Text as="p" variant="caption" tone="muted">
        {description}
      </Text>
      {preview && (
        <pre
          // eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the preview block from the option description above (no named margin utility)
          className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/60 p-xs font-mono text-3xs text-muted-foreground"
        >
          {preview}
        </pre>
      )}
    </>
  );
}
