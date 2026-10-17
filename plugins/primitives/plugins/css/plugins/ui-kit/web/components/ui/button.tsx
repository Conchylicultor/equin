import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, useRef, useState } from "react";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import {
  WithTooltip,
  type Tooltipped,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/tooltip";
import {
  useControlSize,
  textSizeFor,
  iconSizeFor,
  buttonTextClassFor,
  type ControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const refreshIcon = symbol("refresh");

// The class walk reports a `cva` table at the call, so this covers the whole
// table: its only raw radii are the `rounded-[min(var(--radius-md),Npx)]`
// clamps on the xs / sm / inline sizes, which cap a small control's corner
// whatever the Shape preset says (the same clamp `select.tsx` documents).
// eslint-disable-next-line radius/no-adhoc-radius -- intentional min() clamps pin the small sizes' corners below the Shape preset's radius
const buttonVariants = cva(
  "group/button focus-ring inline-flex shrink-0 items-center justify-center rounded-control border border-transparent bg-clip-padding font-control whitespace-nowrap transition-all select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // Its hairline and fill are the palette's `outlineBorder` /
        // `outlineFill` — defaults `border` + the canvas in light mode, `input`
        // + `input` at 30% in dark mode, exactly the pairs it always wore — so a
        // theme restyles every outlined control (and every segment of an
        // outlined ButtonGroup: the seam between two segments is their shared
        // hairline) at once. Its hover is the palette's `outlineHover` /
        // `outlineHoverForeground` (defaults `muted` in light mode, `input` at
        // 50% in dark, + `foreground`), so a theme whose fill already is its
        // muted tone can still step the hover visibly off it.
        outline:
          "border-outline-border bg-outline-fill hover:bg-outline-hover hover:text-outline-hover-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        // Ghost is the ONE transparent variant — it has no background of its
        // own, so its hover tone belongs to the surface it was dropped into, not
        // to the page canvas. `bg-hover-fill` follows `--hover-fill`, which every
        // surface co-publishes (see `SURFACE_LEVELS` / the app-shell sidebar);
        // it defaults to `--muted`, so on the canvas this is byte-identical to
        // the `bg-muted` it replaces. The former `dark:hover:bg-muted/50` is
        // deliberately gone: that half-strength dark hover made ghost the only
        // control that highlighted weaker than the menu items and sidebar rows
        // beside it — the same inconsistency this token exists to remove.
        // The other variants paint their own background, so their hover is
        // relative to THEMSELVES and correctly stays a fixed token.
        ghost:
          "hover:bg-hover-fill hover:text-foreground aria-expanded:bg-hover-fill aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // The OPTIONAL affordance — attach, add, point at: something the user
        // may do beside the main action, so it sits quieter than `outline`. No
        // fill, a dashed hairline and a muted label, all brought to full
        // strength on hover (and while its popover is open).
        dashed:
          "border-dashed border-muted-foreground/40 text-muted-foreground hover:border-muted-foreground/70 hover:text-foreground aria-expanded:border-muted-foreground/70 aria-expanded:text-foreground",
        // A FRAME and nothing else: `outline`'s hairline with no fill of its
        // own, so — like `ghost` — it wears the surface it sits on and hovers
        // to that surface's `--hover-fill`. `outline` paints a fill (the canvas,
        // or `input/30` in dark mode), which on any other surface — the app
        // chrome's graphite bar — shows as a lighter patch behind the label.
        frame:
          "border-border hover:bg-hover-fill hover:text-foreground aria-expanded:bg-hover-fill aria-expanded:text-foreground",
        // A control that FLOATS over content — a zoom chip on a canvas, a
        // "Dismiss all" under the toast stack, a jump-to-bottom over a feed. It
        // paints the overlay surface (`bg-popover`), which is solid in every
        // scheme, and carries its own shadow. Every other bordered variant is
        // see-through somewhere (`outline` is `input/30` in dark mode, `frame`
        // and `ghost` have no fill), so whatever scrolls underneath shows
        // through the label. `ui-kit/no-button-shadow` sends every
        // `shadow-*` on a Button here.
        floating:
          "border-border bg-popover text-popover-foreground shadow-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      // A text size is the density token group's bundle for that size: height
      // (`control-*`), inline padding (`px-control-*`) and icon gap
      // (`gap-control-*`) — so a preset sets a button's width rhythm, not only
      // its height. Never a numeric `px-`/`gap-` here: that is the width a
      // theme cannot reach.
      // The icon is the size's density token (`size-control-icon-*`, the
      // density group's `controlIcon*`). Its defaults follow the TEXT, not the
      // box: `sm` sets the same 14px label as `md` (`buttonTextClassFor`), so it
      // keeps the 16px icon; only `xs`, whose text drops a rung, gets 12px.
      // The corners are the shape group's control radius roles:
      // `rounded-control` (md / lg and every ButtonGroup segment) and the
      // capped `rounded-control-sm` / `-xs` for the small sizes.
      size: {
        md: "control-md gap-control-md px-control-md [&_svg:not([class*='size-'])]:size-control-icon-md",
        default:
          "control-md gap-control-md px-control-md [&_svg:not([class*='size-'])]:size-control-icon-md",
        xs: "control-xs gap-control-xs px-control-xs rounded-control-xs in-data-[slot=button-group]:rounded-control [&_svg:not([class*='size-'])]:size-control-icon-xs",
        sm: "control-sm gap-control-sm px-control-sm rounded-control-sm in-data-[slot=button-group]:rounded-control [&_svg:not([class*='size-'])]:size-control-icon-sm",
        lg: "control-lg gap-control-lg px-control-lg [&_svg:not([class*='size-'])]:size-control-icon-lg",
        icon: "control-icon-md [&_svg:not([class*='size-'])]:size-control-icon-md",
        "icon-xs":
          "control-icon-xs rounded-control-xs in-data-[slot=button-group]:rounded-control [&_svg:not([class*='size-'])]:size-control-icon-xs",
        "icon-sm":
          "control-icon-sm rounded-control-sm in-data-[slot=button-group]:rounded-control [&_svg:not([class*='size-'])]:size-control-icon-sm",
        "icon-lg":
          "control-icon-lg [&_svg:not([class*='size-'])]:size-control-icon-lg",
        // Sized by the surrounding text, so it has no control role: its
        // weight is the fixed medium, not the themable control weight.
        inline:
          "h-auto rounded-[min(var(--radius-md),8px)] p-2xs align-middle text-[1em] font-medium [&_svg:not([class*='size-'])]:icon-auto",
      },
      // A pill's rounded ends take room a rectangle's corners don't: `pill-ends`
      // adds the shape group's pill extra to both sides of the size's own
      // `px-control-*`. Icon sizes have no inline padding, so it is inert there.
      shape: {
        default: "",
        pill: "rounded-full! pill-ends",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      shape: "default",
    },
  },
);

/**
 * `loading` shows a spinner and disables the button. It is also driven
 * automatically: if `onClick` returns a promise, the button enters the pending
 * state until it settles — so any async action is double-click-proof and
 * self-indicating with zero per-call-site wiring. The public `onClick` type is
 * left as base-ui's standard handler so consumers and value-returning handlers
 * keep type-checking; the promise is detected at runtime.
 *
 * `tooltip` (see {@link Tooltipped}) is the button's hover name — the themed
 * tooltip, never the native `title`, which the props reject. An icon-shaped
 * button with a plain-string tooltip and no `aria-label` takes the tooltip as
 * its accessible name, as the native `title` used to give it.
 */
type ButtonOwnProps = Omit<ButtonPrimitive.Props, "title"> &
  Omit<VariantProps<typeof buttonVariants>, "size"> &
  DensityControlled &
  Tooltipped & {
    aspect?: "text" | "icon" | "inline";
    loading?: boolean;
  };

function Button({
  className,
  variant = "default",
  aspect = "text",
  shape = "default",
  loading = false,
  disabled = false,
  onClick,
  tooltip,
  tooltipSide,
  children,
  ...props
}: ButtonOwnProps) {
  // Density (height) is ALWAYS ambient — read from `useControlSize()` (set by a
  // toolbar/slot/region), never a per-instance dial that can desync from
  // neighbors. `aspect` selects the orthogonal SHAPE axis: "text" → text density,
  // "icon" → a square icon box at that same density, "inline" → the inline escape
  // (collapses to surrounding text height). There is no per-instance density
  // override.
  const density = useControlSize();
  const resolvedSize =
    aspect === "inline"
      ? "inline"
      : aspect === "icon"
        ? iconSizeFor(density)
        : textSizeFor(density);

  // Text size flows through the shared density→text policy (textStepFor, also
  // consumed by Badge + Text). The `inline` aspect keeps its own `text-[1em]`
  // (collapses to surrounding text height), so it opts out.
  const textClass =
    aspect === "inline" ? undefined : buttonTextClassFor(density);

  // Auto-pending: if the handler returns a promise, reflect in-flight state
  // until it settles. Guard setState against unmount mid-flight.
  const [autoPending, setAutoPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const handleClick: NonNullable<ButtonPrimitive.Props["onClick"]> = (
    event,
  ) => {
    const result = onClick?.(event) as unknown;
    if (result && typeof (result as { then?: unknown }).then === "function") {
      setAutoPending(true);
      void Promise.resolve(result).finally(() => {
        if (mounted.current) setAutoPending(false);
      });
    }
  };

  const isLoading = loading || autoPending;
  // Icon-shaped buttons have no label, so the spinner replaces the glyph;
  // text buttons keep their label with the spinner as a leading indicator.
  const iconOnly = resolvedSize.startsWith("icon");

  const ariaLabel =
    props["aria-label"] ??
    (aspect === "icon" && typeof tooltip === "string" ? tooltip : undefined);

  return (
    <WithTooltip content={tooltip} side={tooltipSide}>
      <ButtonPrimitive
        data-slot="button"
        className={cn(
          buttonVariants({ variant, size: resolvedSize, shape }),
          textClass,
          className,
        )}
        disabled={disabled || isLoading}
        data-loading={isLoading || undefined}
        onClick={onClick ? handleClick : undefined}
        {...props}
        aria-label={ariaLabel}
        // After the spread: a popover/menu trigger rendering this Button passes
        // its own `data-slot`, so only a marker nothing else sets survives. It is
        // how ButtonGroup tells a segment from the hidden spans a library adds.
        data-button-group-segment=""
      >
        {isLoading ? (
          iconOnly ? (
            <Icon icon={refreshIcon} className="animate-spin" />
          ) : (
            <>
              <Icon icon={refreshIcon} className="animate-spin" />
              {children}
            </>
          )
        ) : (
          children
        )}
      </ButtonPrimitive>
    </WithTooltip>
  );
}

export { Button, buttonVariants };
export type { ControlSize };
