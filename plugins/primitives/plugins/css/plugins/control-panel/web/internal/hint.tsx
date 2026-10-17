import {
  cn,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type React from "react";

export interface HintedLabelCellProps {
  /**
   * The prose. Undefined is the ordinary case — the cell is then exactly the
   * plain `<span>` it has always been, with no tooltip machinery around it.
   */
  hint?: string;
  /**
   * A VISIBLE second line under the label — muted prose that reserves its own
   * height (it wraps, never truncates). The deliberate opposite of `hint`, for a
   * choice whose meaning must be read before it is picked (a page's kind). See
   * `ControlPanelRowCommon.description`.
   */
  description?: string;
  /** From the host's own `useId()`, so the row can point at it. */
  descriptionId: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A row's LABEL cell, with `hint` wired into it.
 *
 * `hint` is prose as a TOOLTIP, never a second line. A second line is the one
 * change that breaks invariant #2 in every panel at once, and a muted pseudo-row
 * breaks invariant #1's meaning — a row that is not a control still opening the
 * rails. So the hint costs no height and reserves no track: it adds a leading
 * glyph to nothing, a trailing cell to nothing, and a column to nothing.
 *
 * It lands in the LABEL cell rather than around the row for that last reason. A
 * `WithTooltip` around the row's HOST would have to merge props and a ref into
 * whichever of the three elements the row inferred, and the label cell is
 * already the widest box in the row — `minmax(0, 1fr)` — so it is what the
 * pointer is over anyway.
 *
 * Two readings of one string, which is deliberate: sighted users get the
 * tooltip, and assistive tech gets an `aria-describedby` pointing at a zero-box
 * `sr-only` sibling inside the cell. `sr-only` is `position: absolute`, so the
 * description generates no box in the grid and cannot widen the label track or
 * push the row onto a second line. A tooltip alone would be invisible on touch
 * and unreachable by a screen reader; a description alone would be invisible to
 * everyone else.
 *
 * That sibling is `aria-hidden`, and it has to be: it lives INSIDE the row, so
 * without it the row's accessible NAME would be its label followed by its whole
 * hint — the same defect the icon cell is hidden for one file over. A node that
 * is *directly referenced* by `aria-describedby` still contributes its text to
 * the description even when hidden (accname §2A), so the description survives
 * and only the name is spared.
 */
export function HintedLabelCell({
  hint,
  description,
  descriptionId,
  className,
  children,
}: HintedLabelCellProps) {
  if (description !== undefined) {
    return (
      <DescribedLabelCell
        description={description}
        descriptionId={descriptionId}
        className={className}
      >
        {children}
      </DescribedLabelCell>
    );
  }
  const cell = (
    <span data-cp-cell="label" className={cn("truncate", className)}>
      {children}
      {hint ? (
        <span aria-hidden id={descriptionId} className="sr-only">
          {hint}
        </span>
      ) : null}
    </span>
  );
  if (!hint) return cell;
  return <WithTooltip content={hint}>{cell}</WithTooltip>;
}

/**
 * The label cell of a row that carries a visible `description`: the label on
 * its own line (still truncating), the description under it as muted caption
 * prose that WRAPS. A flow container, so it resets the row's single-line
 * contract for the description only; the label keeps its own `truncate`.
 *
 * The description is the row's accessible description by `aria-describedby`
 * (the host points at `descriptionId`) and is `aria-hidden` inside the cell, so
 * the row's NAME stays its label alone — the same split `hint` makes.
 *
 * The label is a TITLE over its prose — medium weight in the strong text tier —
 * so the choice reads first and its meaning second.
 *
 * The cell pads itself vertically so two lines sit inside the row's box with
 * the breathing room a one-line row gets from `--cp-row-h`; the row's
 * `min-height` then grows to fit rather than clipping.
 */
function DescribedLabelCell({
  description,
  descriptionId,
  className,
  children,
}: {
  description: string;
  descriptionId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Stack
      as="span"
      gap="2xs"
      data-cp-cell="label"
      data-cp-described=""
      className={cn("min-w-0 py-xs", className)}
    >
      <span className="truncate font-medium text-strong-foreground">
        {children}
      </span>
      <span
        aria-hidden
        id={descriptionId}
        className="text-caption whitespace-normal text-muted-foreground"
      >
        {description}
      </span>
    </Stack>
  );
}
