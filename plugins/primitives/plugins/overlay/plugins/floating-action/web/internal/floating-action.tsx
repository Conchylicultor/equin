import {
  rampClass,
  type SpaceStep,
} from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import {
  type StackAlign,
  type StackDirection,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  cn,
  OverlayPanel,
  type PopoverPadding,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { PopupOpenScope } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { useDisclosureIntent } from "./use-disclosure-intent";

export type FloatingAnchor =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Which end of the panel's axis the trigger sits at; content fills the other. */
export type FloatingActionTriggerAt = "start" | "end";

const anchorClasses: Record<FloatingAnchor, string> = {
  "top-left": "top-0 left-0",
  "top-right": "top-0 right-0",
  "bottom-left": "bottom-0 left-0",
  "bottom-right": "bottom-0 right-0",
};

// The panel's flow, from the two roles that decide it. The primitive fixes the
// trigger as the FIRST DOM child (it owns the rigid collapsed-footprint
// wrapper), so "the trigger sits at the end" is a REVERSED flex direction — and
// reversal also flips where the panel packs its items, which is what keeps the
// trigger flush against a clamped panel's far edge while the content is revealed
// past the other one. Both halves are mechanics; the call site states the roles.
const FLOW_CLASS: Record<
  StackDirection,
  Record<FloatingActionTriggerAt, string>
> = {
  row: { start: "flex-row", end: "flex-row-reverse" },
  col: { start: "flex-col", end: "flex-col-reverse" },
};

const ALIGN_CLASS: Record<StackAlign, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
  baseline: "items-baseline",
};

export interface FloatingActionProps extends Omit<
  ComponentProps<"div">,
  "className"
> {
  /**
   * The panel's card. The panel IS ui-kit's `OverlayPanel`, so open it wears
   * the theme's popover surface unless the variant is its own surface:
   * - `outlined` — collapsed, a hairline ring, a translucent blurred ground and
   *   a soft shadow; open, the popover.
   * - `ghost` — no card while collapsed; open, the popover.
   * - `glass` — a frosted capsule that is the same collapsed and open: a
   *   hairline RING (a box-shadow, so it adds no size — the panel is exactly
   *   pad + content tall), a more translucent ground under a stronger,
   *   saturated blur, and a deeper floating shadow. For a bar that floats
   *   over arbitrary app content and must read as one surface at rest.
   */
  variant?: "outlined" | "ghost" | "glass";
  /**
   * The panel's corners: `rounded` (the default, the popover's corner role) or `pill`
   * (fully rounded ends — a capsule around a single row of controls).
   */
  shape?: "rounded" | "pill";
  className?: string;
  /**
   * SIZING ONLY — the panel's collapsed→open morph (`max-w-*` / `max-h-*` /
   * `w-*`), which the primitive animates but deliberately does not size, since
   * the open extent is a per-call-site measurement. The panel's LAYOUT is the
   * props above (`direction` / `triggerAt` / `align` / `gap` / `pad`), and this
   * field cannot take it back: its `ClassName` brand means the value comes out
   * of `cn()`, so `no-adhoc-layout` reads its tokens and rejects any flow,
   * alignment, positioning or clipping class written here.
   */
  panelClassName?: ClassName;
  /** Axis the panel's content flows along. Defaults to `row`. */
  direction?: StackDirection;
  /** Which end of `direction` the trigger sits at. Defaults to `start`. */
  triggerAt?: FloatingActionTriggerAt;
  /** Cross-axis alignment of the trigger against the content (`items-*`). */
  align?: StackAlign;
  /** Gap between the trigger and the content, from the spacing ramp. */
  gap?: SpaceStep;
  /** Padding inside the panel — the popover's own padding role (its rail). */
  pad?: PopoverPadding;
  closeDelay?: number;
  anchor?: FloatingAnchor;
  /**
   * The always-visible collapsed footprint — the element shown while the panel
   * is closed (e.g. the trigger icon/glyph). The primitive renders it in an
   * own, rigid wrapper that **never flex-shrinks**, so it can never collapse to
   * 0 even when `children` are a tall/wide sibling under a clamped panel.
   * Declare the role here; `children` hold the expanding content.
   *
   * A function receives whether the panel is open, for a trigger that says
   * something different collapsed than expanded (a collapsed mark summarising
   * what the open panel's items then show for themselves).
   */
  trigger: ReactNode | ((open: boolean) => ReactNode);
  /**
   * The accessible name of the control. It lands on the stable wrapper — the
   * element that takes focus and carries `aria-expanded` — not on the panel,
   * which is `inert` while closed and so names nothing a user can reach.
   */
  label?: string;
}

/**
 * A popup opened from inside the panel (the options picker's version list)
 * holds the panel open: it is drawn outside the panel's box, so reaching for
 * it would otherwise read as leaving the control. Popups report to their
 * NEAREST scope, so this scope takes over from any enclosing one.
 */
export function FloatingAction(props: FloatingActionProps) {
  return (
    <PopupOpenScope>
      {(popupOpen) => <FloatingActionPanel {...props} held={popupOpen} />}
    </PopupOpenScope>
  );
}

function FloatingActionPanel({
  held,
  className,
  panelClassName,
  direction = "row",
  triggerAt = "start",
  align,
  gap,
  pad = "none",
  variant = "outlined",
  shape = "rounded",
  closeDelay,
  anchor = "bottom-right",
  trigger,
  label,
  children,
  ...props
}: FloatingActionProps & { held: boolean }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  // How much bigger the collapsed panel is than its trigger, per axis: the
  // panel's padding + border, plus whatever the collapsed `children` and the
  // gap add along the flow. Read once, the first time the panel has a box while
  // closed — the one moment it is guaranteed to be at rest (nothing has opened
  // it yet, so no morph can be in flight).
  const chromeRef = useRef<{ width: number; height: number } | null>(null);
  const { open, rootProps } = useDisclosureIntent(wrapperRef, closeDelay, held);

  // The morphing panel is `position: absolute`, so it contributes no intrinsic
  // size to the wrapper. Pin the wrapper to the panel's *collapsed* footprint so
  // it (a) reserves in-flow space where consumers place it in a row and (b) gives
  // the corner-anchored panel a box to grow out from. Crucially this keeps the
  // hover hitbox (the wrapper) a *stable* size while the panel morphs over it —
  // the structural cure for open/close flicker. The wrapper is positioned by the
  // consumer's own className (`absolute`/`fixed`/`relative` + offsets + z), so it
  // stays glued to — and clipped by — its parent. No portal, no viewport
  // tracking: native layout repositions it on every reflow, including a sibling
  // pane opening alongside it.
  //
  // "Stable" means it never follows the OPEN panel — not that it is frozen. The
  // trigger is live content (a status dot that grows into a pill with a count),
  // and while closed the panel is `inert`, so the wrapper is the only way in: a
  // hitbox left at the trigger's old size would leave the grown part of it
  // neither hoverable nor clickable. So the footprint is derived, never re-read
  // off the panel (which may be mid-morph): trigger size + the chrome measured
  // at rest. The derivation is size-only, so it holds for every `anchor`,
  // `direction` and `triggerAt` — the collapsed panel sits exactly on the
  // wrapper from whichever corner it is anchored at.
  //
  // While open, nothing is written: the hitbox holds still under the morph, and
  // a trigger that reshapes itself on open (the outline rail clips its dashes
  // away) cannot shrink it. `open` is a dep, so closing re-derives the footprint
  // at once from whatever the trigger became in the meantime.
  useResizeObserver(
    triggerRef,
    () => {
      if (open) return;
      const wrapper = wrapperRef.current;
      const panel = panelRef.current;
      const triggerBox = triggerRef.current;
      if (!wrapper || !panel || !triggerBox) return;
      const trig = triggerBox.getBoundingClientRect();
      let chrome = chromeRef.current;
      if (!chrome) {
        const rest = panel.getBoundingClientRect();
        // No box yet (mounted under a `display: none` ancestor, e.g. a
        // background tab): there is nothing to measure. The trigger's first
        // resize once it is shown brings us back here.
        if (rest.width === 0 && rest.height === 0) return;
        chrome = {
          width: rest.width - trig.width,
          height: rest.height - trig.height,
        };
        chromeRef.current = chrome;
      }
      // The boxes above are measured in viewport px, which already carry any
      // CSS `zoom` on the wrapper or its ancestors; a length written into the
      // wrapper's style is scaled by that zoom again. Divide it back out, or a
      // zoomed control's hitbox comes out zoom² the size of its panel (and a
      // `my-auto`-centred one drags the panel off-centre).
      const zoom = wrapper.currentCSSZoom;
      wrapper.style.width = `${(trig.width + chrome.width) / zoom}px`;
      wrapper.style.height = `${(trig.height + chrome.height) / zoom}px`;
    },
    { deps: [open] },
  );

  return (
    <div
      ref={wrapperRef}
      className={cn("group/fa outline-none", className)}
      data-open={open || undefined}
      aria-label={label}
      {...rootProps}
    >
      <div className={cn("absolute w-max", anchorClasses[anchor])}>
        <OverlayPanel
          ref={panelRef}
          // THE popover panel — the one every popover, menu and floating
          // surface renders — so the open panel's paint (`--popover`, its ring,
          // radius and shadow roles) and its padding rail are the theme's, never
          // a lookalike of it. It is not a scroller here (`scroll={false}`): the
          // panel owns its overflow, clipping the morph below.
          scroll={false}
          padding={pad}
          // Closed content is inert: invisible (FadeIn) panel items must not be
          // pointer- or Tab-reachable. The stable wrapper underneath still
          // receives the pointer-enter that opens it.
          inert={!open}
          // `overflow-hidden` here clips the width/height transition, not text.
          // The panel is a flex box along `direction` whose ONE child fills it
          // (`flex-1 min-*-0`): a panel clamped by the morph's max-w / max-h
          // then clamps that child too, so its reversed flow still packs the
          // trigger against the far edge, and the child starts on the panel's
          // padding rail as `OverlayPanel` expects of its children.
          className={cn(
            "flex overflow-hidden",
            // A pill capsule's controls echo its ends: every control inside
            // rounds fully (the shape group's control radius roles, every size's,
            // re-read here),
            // so a hovered button is a pill inside the pill, never a
            // rounded-rect patch in a capsule. `rounded` keeps the popover's
            // own corner role.
            shape === "pill" &&
              "rounded-full [--radius-control:calc(infinity*1px)] [--radius-control-sm:calc(infinity*1px)] [--radius-control-xs:calc(infinity*1px)]",
            FLOW_CLASS[direction][triggerAt],
            "transition-[width,max-width,max-height,padding,background-color,box-shadow] duration-200 ease-out",
            // Collapsed, `outlined` / `ghost` lay their resting look over the
            // popover paint; open, the popover paint is the whole look.
            !open &&
              variant === "outlined" &&
              "bg-background/80 shadow-sm ring-border/60 backdrop-blur",
            !open &&
              variant === "ghost" &&
              "bg-transparent shadow-none ring-transparent",
            // Glass is its own surface over whatever app is behind it, so
            // every tone is a translucent mix rather than an opaque step:
            // - ground: the background at 72% under an 18px, 1.6× saturated
            //   blur, so the app shows through, softened;
            // - ring: a hairline of the foreground at 9% (≈ 8% white on the
            //   chrome), lighter than the content behind it by the same
            //   step on light and dark apps alike, plus a 4% top highlight;
            // - shadow: the theme's floating tier (`2xl`);
            // - `--hover-fill`: a ghost control hovers to the foreground at
            //   8% (≈ 7% white) OVER the glass — an opaque hover step would
            //   paint a dark patch on a light app showing through;
            // - `--chrome-mask`: what a cut-out ring (the bell badge's)
            //   draws in, the ground's own tone.
            variant === "glass" && [
              "ring-1 ring-foreground/9 inset-shadow-2xs inset-shadow-foreground/4",
              "bg-background/72 backdrop-blur-[18px] backdrop-saturate-[1.6]",
              "shadow-2xl",
              "[--hover-fill:color-mix(in_oklab,var(--foreground)_8%,transparent)] [--chrome-mask:var(--background)]",
            ],
            panelClassName,
          )}
          {...props}
        >
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1",
              FLOW_CLASS[direction][triggerAt],
              align && ALIGN_CLASS[align],
              gap && rampClass("gap", gap),
            )}
          >
            {/* The trigger's rigid wrapper: this `shrink-0` is the load-bearing
                collapsed-footprint guarantee — the whole point of the slot. It
                keeps the always-visible trigger from flex-shrinking to 0 next to
                a tall/wide `children` sibling under a clamped panel. It is also
                the box whose resizes re-size the hover hitbox above. */}
            <div ref={triggerRef} className="shrink-0">
              {typeof trigger === "function" ? trigger(open) : trigger}
            </div>
            {children}
          </div>
        </OverlayPanel>
      </div>
    </div>
  );
}

export interface FloatingActionFadeInProps extends ComponentProps<"div"> {}

export function FloatingActionFadeIn({
  className,
  ...props
}: FloatingActionFadeInProps) {
  return (
    <div
      className={cn(
        "opacity-0 group-data-open/fa:opacity-100",
        "transition-opacity duration-150 group-data-open/fa:delay-75",
        className,
      )}
      {...props}
    />
  );
}
