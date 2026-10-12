import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  cn,
  textStepFor,
  useControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type React from "react";

/**
 * A LinkChip IS a `Badge`, so its passthrough lands where Badge's does — the
 * chip shell, never the truncating label span inside it. See {@link Passthrough}.
 *
 * The openness is load-bearing, not a convenience. A chip whose click reveals
 * something IN PLACE (a popover, a tooltip) is handed to the overlay as its
 * trigger, and base-ui clones that element with its own handler, ARIA and ref.
 * A closed prop surface drops all three silently, so the chip simply stops
 * opening — which is why the two chips that needed it each worked around this
 * primitive instead of composing it: `commit-link` wrapped it in a spare
 * `Inline` to give the tooltip something clonable, and `ui-context` hand-rolled
 * the whole chip, which is where the look below comes from.
 */
export interface LinkChipProps extends DensityControlled, Passthrough {
  /**
   * What clicking the chip does. A `LinkTarget` gets the browser's link
   * gestures (⌘/Ctrl- and middle-click open its `href` in a new browser tab);
   * a plain function runs on click. Isolated: the chip stops `click` /
   * `auxclick` propagation itself, so a chip inside a clickable row or the
   * page editor never also activates its container.
   *
   * Omitted ONLY when the chip is an overlay TRIGGER (the popover/tooltip
   * wrapper clones it with the handler that opens the panel, and a second one
   * here would fight it) or sits inside one (its press must bubble to it).
   */
  activation?: Activation;
  /**
   * Never a raw handler: a chip's click is its `activation`, which is what
   * gives a navigating chip ⌘/middle-click and isolates it from its container.
   * `never` (rather than omitted) because {@link Passthrough}'s index signature
   * would otherwise accept one. A chip that does something other than navigate
   * passes a plain function as `activation`; an overlay trigger's handler is
   * cloned on by the overlay at runtime, not passed here.
   */
  onClick?: never;
  onAuxClick?: never;
  /** StatusDot or icon, rendered before children. */
  leading?: React.ReactNode;
  /** Monospace label (for ids). Applies font-mono to the children wrapper. */
  mono?: boolean;
  title?: string;
  className?: string;
  /** Label (+ optional trailing count). */
  children: React.ReactNode;
}

/**
 * The chip's own chrome, on top of the Badge shell.
 *
 * It reads as an OBJECT sitting in the sentence — an outlined tile you can
 * point at — rather than as a run of link text. That is deliberate, and it is a
 * reversal: the chip used to paint its label `text-primary-text` and underline it on
 * hover, borrowing the web's convention for a link inside prose. In a paragraph
 * that names half a dozen tasks, attempts and pages, the result was a wall of
 * accent-colored words, and the accent stopped meaning anything.
 *
 * So the affordance moved off the letters and onto the box: normal foreground
 * text, a hairline border, and a background that lifts to `accent` under the
 * pointer. The pointer cursor carries the weight the underline used to, and it
 * is not written here — the base layer gives it to every `<button>`, which is
 * what the chip is.
 */
const CHIP_CHROME =
  "border border-border text-foreground hover:bg-accent transition-colors";

export function LinkChip({
  activation,
  leading,
  mono,
  title,
  className,
  children,
  ...rest
}: LinkChipProps) {
  // One rung ABOVE the plain Badge label. A chip in running text sits among
  // body copy, not among the toolbar labels a status Badge lives with, so the
  // caption size reads as shrunken beside the sentence holding it. Stepping the
  // rung rather than naming a size keeps Badge's density contract: the compact
  // `xs` density still drops one, exactly as it does for the caption.
  //
  // The step up is a correction for the PROPORTIONAL face, and only that face.
  // A size rung is a number of pixels, not an amount of ink: swap the family and
  // the same number lands somewhere else. The monospace face sets far wider —
  // the word "files" runs 39px in the mono label where the 14px sentence around
  // it runs 25px — so a mono chip that also took the step read as the biggest
  // thing in the paragraph, which is the opposite of what the step is for. A
  // mono label therefore keeps Badge's own rung, which is exactly the size
  // markdown gives inline `code` in the same prose: the two now match.
  const density = useControlSize();
  const textClass = mono
    ? undefined
    : textStepFor(density)
      ? "text-label-compact"
      : "text-label";

  return (
    <Badge
      as="button"
      type="button"
      {...activationProps(activation, { isolate: true })}
      title={title}
      icon={leading}
      mono={mono}
      colorClass="bg-muted"
      className={cn(CHIP_CHROME, textClass, className)}
      {...rest}
    >
      {children}
    </Badge>
  );
}
