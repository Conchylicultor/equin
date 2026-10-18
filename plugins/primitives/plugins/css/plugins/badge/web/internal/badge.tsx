import {
  cn,
  useControlSize,
  textStepFor,
  WithTooltip,
  type DensityControlled,
  type Tooltipped,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { BadgeVariant } from "../../core";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import { copiesAsOwnText } from "@plugins/primitives/plugins/dom/plugins/copy-source-text/web";
import type React from "react";

// Re-exported so every existing `import { BadgeVariant } from ".../badge/web"`
// keeps working: the name lives in `core` (a data declaration in another
// plugin's `core` has to be able to spell it), the classes live here.
export type { BadgeVariant };

/** Corner treatment. "rect" = status-label rounded rectangle; "pill" = filter/toggle pill. */
export type BadgeShape = "rect" | "pill";

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/15 text-primary-text",
  warning: "bg-warning/15 text-warning",
  destructive: "bg-destructive/15 text-destructive",
  success: "bg-success/15 text-success",
  info: "bg-info/15 text-info",
  absent: "text-faint-foreground line-through ring-1 ring-border ring-inset",
};

/**
 * A badge renders three elements — the chip shell, the content line centred
 * inside it, and the truncating label span in that line. `ref` and everything
 * spread beside it land on the SHELL, the outer one: it is the chip as far as a
 * caller is concerned, and the inner spans are implementation details of how
 * the label centres and ellipsizes. See {@link Passthrough}.
 */
export interface BadgeProps extends DensityControlled, Tooltipped, Passthrough {
  /** Semantic color variant. Default "muted". Ignored when `colorClass` is set. */
  variant?: BadgeVariant;
  /** Corner treatment. Default "rect" (rounded rectangle); "pill" → fully rounded. */
  shape?: BadgeShape;
  /** Color-only escape hatch: replaces the variant bg/text classes (map-driven colors). */
  colorClass?: string;
  /** Leading icon or StatusDot, rendered before the label (stays rigid; never truncates). */
  icon?: React.ReactNode;
  /** Monospace label (for ids). Applies font-mono to the label wrapper. */
  mono?: boolean;
  /** Element to render. Default "span"; pass "button" for interactive badges. */
  as?: React.ElementType;
  className?: string;
  children: React.ReactNode;
}

export function Badge({
  variant = "muted",
  shape = "rect",
  colorClass,
  icon,
  mono,
  as: As = "span",
  className,
  tooltip,
  tooltipSide,
  children,
  ...rest
}: BadgeProps) {
  const density = useControlSize();
  // A chip's words are the `tag` role (`text-tag` + its weight token
  // `font-tag`), and its size tracks ambient control density via the single
  // density→text policy (textStepFor, shared with Button + Text): the compact
  // `xs` density steps down to the tag role's OWN compact rung
  // (`text-tag-compact`, whose tokens default to the 2xs sub-scale), every other
  // density (incl. the no-provider default "md") reads the tag role. The weight
  // is its own utility, so a chip that swaps the size (ToggleChip's `text-2xs`)
  // keeps it. Padding and radius are chip tokens too (`p-chip-compact`,
  // `rounded-chip-compact`), so a theme can give a dense row's count chip its
  // own tighter shape without touching any other chip.
  const compact = textStepFor(density) === 1;
  const sizeClass = compact
    ? "p-chip-compact text-tag-compact font-tag"
    : "p-chip text-tag font-tag";
  return (
    <WithTooltip content={tooltip} side={tooltipSide}>
    <As
      className={cn(
        // The chip shell, shared by every chip role (LinkChip/ToggleChip compose this).
        // region-line = items-center + whitespace-nowrap (the single-line invariant).
        // max-w-full + the inner truncate span make a chip a well-behaved content leaf:
        // a long label ellipsizes instead of overflowing. align-baseline puts the chip
        // on the baseline of a sentence holding it — and the label's own `self-baseline`
        // below decides WHICH baseline the chip offers the sentence.
        "inline-flex region-line max-w-full gap-xs align-baseline tabular-nums [&_svg:not([class*='size-'])]:icon-auto",
        sizeClass,
        shape === "rect" && (compact ? "rounded-chip-compact" : "rounded-md"),
        // `pill-ends`: a chip on the control scale (ToggleChip's `px-control-*`)
        // takes the shape group's pill extra on both ends, like a pill Button.
        // Inert on the chip scale (`p-chip`), which does not read it.
        shape === "pill" && "rounded-full pill-ends",
        colorClass ?? VARIANT_CLASS[variant],
        className,
      )}
      // A badge's label sits in the truncating span below, which is a flex item
      // — and CSS blockifies every flex item. The clipboard's plain-text
      // serializer puts a newline before and after every block-level box, so a
      // badge in running text copies as three lines. Declaring the badge as
      // copying its own text collapses it back to one, without touching the box
      // model the truncation depends on. Placed BEFORE the passthrough so a
      // caller standing in for something else (an active-data chip declaring its
      // source token) overrides it rather than fighting it.
      {...copiesAsOwnText}
      {...rest}
    >
      {/*
       * The chip's content line: icon + label, sized to its own content and
       * centred in the shell by region-line's `items-center`. It is what keeps
       * the label centred however tall the shell is.
       *
       * Without it, a shell given a fixed height (ToggleChip's control heights)
       * left the label at the TOP of the space inside the padding while the icon
       * sat in the middle: a baseline-aligned flex item has nowhere to go but
       * the start edge of its line, and a single-line flex container with a
       * fixed height makes that line the whole inner box. The label only looked
       * centred while the padding happened to leave exactly one line of height.
       * Inside this box the line is only as tall as its content, so there is no
       * spare height for the label to sit at the top of.
       *
       * `gap-inherit` takes the gap the caller set on the shell, so a caller
       * still spaces icon and label with a gap class on the chip itself.
       * `min-w-0` lets the box shrink so the label below can ellipsize.
       */}
      <span className="inline-flex min-w-0 items-center gap-inherit">
        {icon}
        {/*
         * `self-baseline` on the LABEL is what makes the shell's `align-baseline`
         * mean anything, and it is the only line here that decides where a chip
         * sits in a sentence.
         *
         * An inline-flex box does not have a baseline of its own — it hands the
         * line the baseline of its FIRST flex item. The first item here is the
         * leading icon, and an SVG's baseline is its bottom edge. So a chip in
         * running text used to hang its icon's bottom edge off the sentence's
         * baseline, which carried the label about 3.5px higher than the words
         * beside it and pushed the whole line taller to make room. Every chip in
         * a paragraph read as floating.
         *
         * Marking the label as the one baseline-aligned item makes this content
         * line offer up the label's own text baseline, and the shell hands on
         * the baseline of its only item — this line — so the label sits on the
         * sentence's baseline like a word. The icon still takes `items-center`,
         * so it stays centred on the label, and the chip's box is exactly the
         * size it was.
         */}
        <span className={cn("truncate self-baseline", mono && "font-mono")}>
          {children}
        </span>
      </span>
    </As>
    </WithTooltip>
  );
}
