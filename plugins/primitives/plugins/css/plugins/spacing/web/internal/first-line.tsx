import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useTextVariantClass,
  type TextVariant,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import type React from "react";

/**
 * The box of a leading mark (an icon, a status dot, a numbered badge) that must
 * sit on the FIRST line of the text beside it, however many lines that text
 * wraps to: exactly one line tall (`1lh` — the line height it inherits from the
 * row, the same one its text sibling sets) and centring the mark inside it,
 * pinned to the row's start so a centred row cannot slide it down.
 *
 * This is what a `mt-0.5` on the mark was guessing at: a nudge tuned by eye to
 * one font size and one icon size, wrong at every other density. The line box
 * is measured by the browser instead, so the mark follows any type rung.
 *
 * The mark must be a CHILD of this box (`<FirstLine><Icon/></FirstLine>`):
 * its own `height` is its glyph size, so the line box cannot be its own.
 *
 * `1lh` is the box's OWN line height, inherited from the row. When the text
 * beside it sets a role of its own (`<Text variant="caption">` in a row that
 * does not), pass that role to `<FirstLine variant>` so the box is one of the
 * text's lines, not one of the row's.
 */
export function firstLineClass(): string {
  return "inline-flex h-[1lh] shrink-0 items-center self-start";
}

export interface FirstLineProps extends React.HTMLAttributes<HTMLElement> {
  /** The type role of the text this mark leads, when the row does not set it
   *  (the box takes that role's line height, compacting as the text does). */
  variant?: TextVariant;
  /** Host element. Defaults to a `span` (a mark sits in a text row). */
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}

/** A leading mark seated on the first line of its text sibling. See {@link firstLineClass}. */
export function FirstLine({
  variant,
  as: As = "span",
  ref,
  className,
  children,
  ...rest
}: FirstLineProps) {
  const role = useTextVariantClass(variant);
  return (
    <As ref={ref} className={cn(firstLineClass(), role, className)} {...rest}>
      {children}
    </As>
  );
}
