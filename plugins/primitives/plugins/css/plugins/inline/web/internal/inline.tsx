import { type SpaceStep } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import {
  Stack,
  type StackAlign,
  type StackJustify,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";

export interface InlineProps extends React.HTMLAttributes<HTMLElement> {
  /** Gap role from the spacing ramp — the only way to space children. Required (mirrors Stack). */
  gap: SpaceStep;
  /** Cross-axis alignment. Default `center` — the icon+label baseline of an inline chip. */
  align?: StackAlign;
  /** Main-axis distribution. */
  justify?: StackJustify;
  /** Allow children to wrap to the next line. */
  wrap?: boolean;
  /** Host element/component. Defaults to a `span` (inline element). */
  as?: React.ElementType;
  /** Forwarded to the rendered element (mirrors Surface/Card/Row/Stack). */
  ref?: React.Ref<HTMLElement>;
}

/**
 * The inline-level sibling of `Stack` — an `inline-flex` flow row for chips, icons,
 * and small affordances that must sit INLINE in a text run, flowing with the
 * surrounding text rather than breaking the line. The home for the
 * `inline-flex … align-baseline` recipe that otherwise scatters as eslint-disabled
 * raw layout in feature code.
 *
 * It DELEGATES to `Stack` (exactly as `Cluster` does) so the gap ramp and
 * align/justify semantics live in exactly one place. The only thing it changes is
 * the display mode:
 *
 *   - `inline-flex` overrides Stack's block-level `flex` (tailwind-merge resolves
 *     the `display` group, so the later class wins) — inline-level without
 *     re-implementing the ramp.
 *   - `align-baseline` (`vertical-align: baseline`) seats the box on the surrounding
 *     text baseline — the same recipe `Badge` uses for inline-in-text chips.
 *   - `max-w-full` bounds the box by its line, as `Badge` bounds a chip. An
 *     inline-level box sizes to its content, so without it a row holding a long
 *     label outgrew its container and was clipped there, and the truncating leaf
 *     inside never got a width to ellipsize at. Built in rather than left to each
 *     caller: a caller that forgot it (the editor's token frame) clipped a chip
 *     instead of truncating it. A caller wanting another bound passes its own
 *     `max-w-*` (tailwind-merge keeps the later one).
 *
 * Deliberately carries NO `min-w-0`: the truncation LEAF inside owns it, keeping
 * the "exactly one primitive owns `min-w-0`" invariant intact.
 *
 * Caller `className` composes last.
 */
export function Inline({
  gap,
  align = "center",
  justify,
  wrap,
  as: As = "span",
  ref,
  className,
  children,
  ...rest
}: InlineProps) {
  return (
    <Stack
      direction="row"
      gap={gap}
      align={align}
      justify={justify}
      wrap={wrap}
      as={As}
      ref={ref}
      className={cn("inline-flex align-baseline max-w-full", className)}
      {...rest}
    >
      {children}
    </Stack>
  );
}
