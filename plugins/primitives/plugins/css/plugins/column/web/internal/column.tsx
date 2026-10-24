import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  rampClass,
  type SpaceStep,
} from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import {
  cn,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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

export type ColumnProps = ColumnBaseProps & ColumnSizing;

interface ColumnBaseProps extends React.HTMLAttributes<HTMLElement> {
  /** Rigid top region — never shrinks (`shrink-0`). */
  header?: ReactNode;
  /** Flexible middle region — by default wrapped in `<Scroll axis="y" fill>` so
   *  it absorbs the column's slack and scrolls; set `scrollBody={false}` for a
   *  plain flexible region that manages its own overflow. */
  body?: ReactNode;
  /** Rigid bottom region — never shrinks (`shrink-0`). */
  footer?: ReactNode;
  /** Wrap `body` in a `<Scroll axis="y" fill>` cell. Defaults to true. */
  scrollBody?: boolean;
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
  hideScrollbar = false,
  fill = false,
  fit = false,
  gap = "none",
  as: As = "div",
  ref,
  className,
  ...rest
}: ColumnProps) {
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
        {header != null && <div className="shrink-0">{header}</div>}
        {body != null &&
          (scrollBody ? (
            <Scroll axis="y" fill hideScrollbar={hideScrollbar}>
              {body}
            </Scroll>
          ) : (
            <div className="min-h-0 flex-1">{body}</div>
          ))}
        {footer != null && <div className="shrink-0">{footer}</div>}
      </As>
    </SingleLineProvider>
  );
}
