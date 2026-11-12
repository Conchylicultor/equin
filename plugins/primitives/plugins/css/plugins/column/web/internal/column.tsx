import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  rampClass,
  type SpaceStep,
} from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import {
  cn,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { railClass } from "@plugins/primitives/plugins/css/plugins/rail/core";
import type React from "react";
import type { ReactNode } from "react";

/**
 * How the column is sized: `fill` fills its flex-col parent (`min-h-0
 * flex-1`); `fit` hugs its content up to its own `max-h-*` (in `className`),
 * past which the body takes what is left and scrolls. Mutually exclusive.
 */
type ColumnSizing =
  | {
      /** Emit the flex-child fill pair (`min-h-0 flex-1`) so the column fills
       *  its own flex-col parent. Defaults to false. */
      fill?: boolean;
      fit?: false;
    }
  | {
      /** Hug the content up to the column's own max-height (a `max-h-*` in
       *  `className`), then scroll the body. Laid out as a grid (`fitRows`). */
      fit: true;
      fill?: false;
    };

/**
 * Who pays the column's inline inset. `inset` makes each of the column's
 * regions a REGION OWNER at that step: the header, the body's scroller and the
 * footer each pay AND publish it (`rail-x-<step>`, owed 0) — so the scroller
 * and its scrollbar still reach the column's edge while its content lands on
 * the rail, and a follower inside (a DataView's bands) pays nothing more.
 * Not the app-shell sidebar's owe/follow split: a follower region would make
 * every follower inside it pay a second time (nested followers each pay).
 * It needs the managed `Scroll` body to own the body's region, so a plain
 * `scrollBody={false}` body cannot take one (tsc).
 */
type ColumnInset =
  | {
      /** Wrap `body` in a `<Scroll axis="y" fill>` cell. Defaults to true. */
      scrollBody?: true;
      /**
       * Open the column as a region inset by this ramp step: header, body and
       * footer content lands on the rail (and bands on its text rail — a
       * column's body is rows, so the text rail is one row pad further in) by
       * doing nothing. Each region also takes the step as block padding.
       * Content inside declares NO inset of its own.
       */
      inset?: SpaceStep;
    }
  | {
      /** A plain flexible body that manages its own overflow. */
      scrollBody: false;
      inset?: undefined;
    };

export type ColumnProps = ColumnBaseProps & ColumnSizing & ColumnInset;

interface ColumnBaseProps extends React.HTMLAttributes<HTMLElement> {
  /** Rigid top region — never shrinks (`shrink-0`). */
  header?: ReactNode;
  /** Flexible middle region — by default wrapped in `<Scroll axis="y" fill>` so
   *  it absorbs the column's slack and scrolls; set `scrollBody={false}` for a
   *  plain flexible region that manages its own overflow. */
  body?: ReactNode;
  /** Rigid bottom region — never shrinks (`shrink-0`). */
  footer?: ReactNode;
  /**
   * Draw the rules between regions: a hairline under the header and one over
   * the footer, spanning the column (the strips are the column's own, never a
   * `border-b px-* py-*` recipe in the slot content).
   */
  rules?: boolean;
  /** Hide the scrollbar chrome on the managed `Scroll` body while keeping it
   *  scrollable. Only applies when `scrollBody` is true. Defaults to false. */
  hideScrollbar?: boolean;
  /** Gap role from the spacing ramp between regions. Defaults to `none` (flush). */
  gap?: SpaceStep;
  /** Host element/component. Defaults to a `div`. */
  as?: React.ElementType;
  /** Forwarded to the rendered element (mirrors Surface/Card/Row). */
  ref?: React.Ref<HTMLElement>;
}

/**
 * The named-slot **column** primitive — a vertical stack of up to three role
 * slots — `header` / `body` / `footer` — laid out as a flex column with the
 * `rigid | flexible | rigid` fill policy baked into one place: the header/footer
 * wrappers are `shrink-0` (never crushed), and the body is the single flexible
 * region.
 *
 * `Column`'s requirement is the textbook flex-column (rigid header,
 * growing+scrolling body, rigid footer) — exactly what `Scroll`'s `fill`
 * (`min-h-0 flex-1 overflow-y-auto`) was built for. So `Column` owns the
 * `flex flex-col` + rigid wrappers and **delegates the scroll body to `Scroll`**
 * (composition); `Scroll` stays the single owner of `overflow`.
 *
 * Callers write roles, never mechanics (no per-call-site `shrink-0` / `min-h-0` /
 * `flex-1`). Only present slots render — an absent slot produces no region. Caller
 * `className` composes last.
 */
/**
 * The `fit` column's row tracks, one per PRESENT slot: header and footer
 * `auto`, the body `minmax(0, 1fr)`. A grid with a max-height sizes its `fr`
 * row against that max once its content would exceed it — so the column hugs
 * its content, then stops at its max and the body row takes what is left
 * (definite, so a `h-full` child of the body resolves against it). A flex
 * column cannot: a flexed item's height is not definite under an `auto`-height
 * container, so a non-scrolling body wrapper's `h-full` child overflows it.
 */
function fitRows(slots: {
  header: boolean;
  body: boolean;
  footer: boolean;
}): string {
  return [
    slots.header && "auto",
    slots.body && "minmax(0, 1fr)",
    slots.footer && "auto",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Column({
  header,
  body,
  footer,
  scrollBody = true,
  inset,
  rules = false,
  hideScrollbar = false,
  fill = false,
  fit = false,
  gap = "none",
  as: As = "div",
  ref,
  className,
  ...rest
}: ColumnProps) {
  // Each region opens its own region at the step — pays and publishes it, with
  // the text rail one row pad in (a column's content is rows) — and takes the
  // same step as block padding, so two regions sit one step apart on each side
  // of their boundary (a group gap, as before the column owned the inset).
  const regionInset =
    inset && cn(railClass({ x: inset }), "rail-rows", rampClass("py", inset));
  return (
    // Flow container (always vertical): RESETS the single-line contract so stacked
    // regions wrap — `whitespace-normal` re-wraps raw text and the `SingleLine`
    // reset stops leaves from truncating, in case the column is nested inside a
    // line container (Row/Bar).
    <SingleLineProvider value={false}>
      <As
        ref={ref}
        className={cn(
          fit ? "grid" : "flex flex-col",
          "whitespace-normal",
          rampClass("gap", gap),
          fill && "min-h-0 flex-1",
          className,
        )}
        {...rest}
        style={
          fit
            ? {
                // One column that never grows past the column's own width
                // (an `auto` track would widen to a long unbreakable line).
                gridTemplateColumns: "minmax(0, 1fr)",
                gridTemplateRows: fitRows({
                  header: header != null,
                  body: body != null,
                  footer: footer != null,
                }),
                ...rest.style,
              }
            : rest.style
        }
      >
        {header != null && (
          <div className={cn("shrink-0", regionInset, rules && "border-b")}>
            {header}
          </div>
        )}
        {body != null &&
          (scrollBody ? (
            <Scroll
              axis="y"
              fill
              hideScrollbar={hideScrollbar}
              className={regionInset}
            >
              {body}
            </Scroll>
          ) : (
            <div className="min-h-0 flex-1">{body}</div>
          ))}
        {footer != null && (
          <div className={cn("shrink-0", regionInset, rules && "border-t")}>
            {footer}
          </div>
        )}
      </As>
    </SingleLineProvider>
  );
}
