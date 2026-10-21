"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import { usePortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-forward";
import { OverlayBoundary } from "@plugins/primitives/plugins/overlay/plugins/overlay-boundary/web";
import { usePortalContainer } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/overlay-panel";
import { usePinOnClick } from "./use-pin-on-click";

/**
 * The closed type-role ladder, spelled here because ui-kit cannot import the
 * text plugin (which builds on ui-kit). The `type-scale:closed-role-ladder`
 * check pins the map below to `TYPE_ROLES`, so a role added there fails until
 * it is added here.
 */
type TooltipTypeRole =
  | "display"
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "label"
  | "group"
  | "caption"
  | "control"
  | "tag"
  | "code";

/**
 * The tooltip's words wear the type ROLE the theme names (`--tooltip-role`,
 * overlay token group, default `caption`) at the weight it picks
 * (`--tooltip-emphasis`: `regular` | `strong`). CSS cannot build a var name
 * from a value, so each role is one literal style query applying that role's
 * own utility — one entry per role of the ladder (tsc demands each; the
 * closed-role-ladder check pins the list to `TYPE_ROLES`). Sizes, leading and weights stay the
 * type-scale group's; the token only chooses among them. Strong exists only for
 * the roles with a strong step (`control`, `tag`). A browser without style
 * queries draws the base `text-caption`.
 */
const TOOLTIP_ROLE_CLASS: Record<TooltipTypeRole, string> = {
  display: "[@container_style(--tooltip-role:display)]:text-display",
  title: "[@container_style(--tooltip-role:title)]:text-title",
  heading: "[@container_style(--tooltip-role:heading)]:text-heading",
  subheading: "[@container_style(--tooltip-role:subheading)]:text-subheading",
  body: "[@container_style(--tooltip-role:body)]:text-body",
  label: "[@container_style(--tooltip-role:label)]:text-label",
  group: "[@container_style(--tooltip-role:group)]:text-group",
  caption: "[@container_style(--tooltip-role:caption)]:text-caption",
  control:
    "[@container_style(--tooltip-role:control)]:text-control [@container_style(--tooltip-role:control)_and_style(--tooltip-emphasis:strong)]:font-control-strong",
  tag: "[@container_style(--tooltip-role:tag)]:text-tag [@container_style(--tooltip-role:tag)_and_style(--tooltip-emphasis:strong)]:font-tag-strong",
  code: "[@container_style(--tooltip-role:code)]:text-code",
};
const TOOLTIP_TYPE = Object.values(TOOLTIP_ROLE_CLASS).join(" ");

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  // The theme's distance is the popup's `tooltip-offset` margin (overlay
  // group, default 4px); a `sideOffset` adds to it.
  sideOffset = 0,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const forwarded = usePortalForwardedAttrs();
  // Inside a PortalHost (a fullscreen region), draw there: under `body` the
  // popup would be invisible.
  const container = usePortalContainer();
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        {...forwarded}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-popover"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            // The chrome is the theme's (overlay token group: fill, ink, ring,
            // corners, padding, shadow, distance, arrow — app.css); the words
            // are the theme's role (`TOOLTIP_ROLE_CLASS`). It appears at
            // once: no entry animation.
            "z-popover inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-xs rounded-tooltip bg-tooltip p-tooltip text-caption text-tooltip-foreground shadow-tooltip ring-1 ring-tooltip-border tooltip-offset has-data-[slot=kbd]:pr-xs **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-popover **:data-[slot=kbd]:rounded-sm",
            TOOLTIP_TYPE,
            className,
          )}
          {...props}
        >
          <OverlayBoundary>{children}</OverlayBoundary>
          <TooltipPrimitive.Arrow className="z-popover tooltip-arrow translate-y-[calc(-50%-2px)] rotate-45 rounded-sm bg-tooltip fill-tooltip data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

/**
 * A tooltip drawn as a CARD: the same hover / focus state machine as
 * `TooltipContent`, but the popup IS the shared `OverlayPanel` — the menu's
 * paint, radius, shadow and animation — at the fixed `card` width, with no
 * arrow. For content that describes one thing in several parts, which the
 * one-line label chrome cannot hold. Not styled per call site: no
 * `className`, and the body is laid out by `overlay/hover-card`.
 *
 * `anchor` replaces the trigger as what the card is placed against (a virtual
 * rect: beside a menu, level with one of its rows).
 */
function TooltipCardContent({
  side = "right",
  sideOffset = 6,
  align = "start",
  anchor,
  wide = false,
  children,
  ...props
}: Omit<TooltipPrimitive.Popup.Props, "render" | "className"> &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "side" | "sideOffset" | "anchor"
  > & {
    /** The card holds side-by-side columns: grow past the card width to fit them. */
    wide?: boolean;
  }) {
  const forwarded = usePortalForwardedAttrs();
  const container = usePortalContainer();
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        {...forwarded}
        anchor={anchor}
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-popover"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-card"
          {...props}
          render={
            <OverlayPanel
              width={wide ? "card-wide" : "card"}
              padding="sm"
              scroll={false}
            >
              {children}
            </OverlayPanel>
          }
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export type TooltipSide = "top" | "right" | "bottom" | "left";

/**
 * The ONE way a control names itself on hover. Every interactive primitive
 * (`Button`, `IconButton`, `Badge` and the chips built on it, `CopyButton`, …)
 * takes these props and draws the themed tooltip from them — so a control can
 * never fall back to the browser's native `title` bubble, which looks nothing
 * like the rest of the app and appears after its own fixed delay.
 *
 * `title` is `never` rather than omitted: a primitive with an open passthrough
 * (`Badge`'s index signature) would otherwise still accept it.
 */
export interface Tooltipped {
  /**
   * Shown on hover and focus. A plain string, or rich content (`<TooltipDoc>`,
   * a `<Kbd>` shortcut). Empty (`undefined`, `null`, `false`, `""`) draws none.
   */
  tooltip?: ReactNode;
  /** Which side of the control the tooltip opens on. Default "top". */
  tooltipSide?: TooltipSide;
  /** Never the native bubble — pass `tooltip`. */
  title?: never;
}

/** Whether a `tooltip` value draws anything. */
function hasTooltip(content: ReactNode): boolean {
  return (
    content !== undefined &&
    content !== null &&
    content !== false &&
    content !== ""
  );
}

export interface WithTooltipProps {
  /**
   * A short label (or a `TooltipDoc`). Something described in parts — a
   * title with an id, chips, a footer — is a hover card
   * (`overlay/hover-card`), which owns that layout and its width.
   */
  content: ReactNode;
  side?: TooltipSide;
  /**
   * A click on the trigger pins the tooltip open (and a second click unpins
   * it), on top of the usual hover. For a trigger whose tooltip IS its content
   * — a status mark with nothing else to do on click — so the click that
   * people try first shows it, and it stays up while they read. A click
   * elsewhere or Esc closes it.
   */
  pinOnClick?: boolean;
  children: ReactElement;
}

/**
 * A plain-string tooltip is also stamped on the trigger as `data-tooltip` —
 * the stable selector a test or e2e script uses where it once read `[title]`.
 */
function tooltipAttr(content: ReactNode) {
  return typeof content === "string" ? content : undefined;
}

/**
 * Puts a themed tooltip on any element. The primitives that take a
 * {@link Tooltipped} `tooltip` prop draw theirs through this; reach for it
 * directly only for an element that is not one of them. Empty `content`
 * renders `children` alone.
 */
export function WithTooltip({
  content,
  side,
  pinOnClick = false,
  children,
}: WithTooltipProps) {
  if (!hasTooltip(content)) return children;
  const body = <TooltipContent side={side}>{content}</TooltipContent>;
  if (pinOnClick)
    return (
      <PinnableTooltip body={body} attr={tooltipAttr(content)}>
        {children}
      </PinnableTooltip>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={children} data-tooltip={tooltipAttr(content)} />
      {body}
    </Tooltip>
  );
}

function PinnableTooltip({
  body,
  attr,
  children,
}: {
  body: ReactElement;
  attr: string | undefined;
  children: ReactElement;
}) {
  const pin = usePinOnClick();
  return (
    <Tooltip {...pin.root}>
      <TooltipTrigger render={children} data-tooltip={attr} {...pin.trigger} />
      {body}
    </Tooltip>
  );
}

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipCardContent,
  TooltipProvider,
};
