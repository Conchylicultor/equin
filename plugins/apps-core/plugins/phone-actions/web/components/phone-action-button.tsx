import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { isChromelessDocument } from "@plugins/primitives/plugins/embed/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  cn,
  useIsMobile,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  renderAsContribution,
  renderIsolated,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import type {
  Contribution,
  SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { PhoneActions, type PhoneActionContribution } from "../slots";
import {
  FAB_SIZE,
  restingPoint,
  snapPlace,
  useFabPlace,
  useViewport,
  type Viewport,
} from "../internal/place";
import { useTuckOnScroll } from "../internal/use-tuck-on-scroll";
import { BottomSheet } from "./bottom-sheet";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

const closeIcon = symbol("close");

/** A press that moves less than this (px) is a tap, not a drag. */
const DRAG_THRESHOLD = 6;
/** A sub-action bubble's diameter (px). */
const BUBBLE = 46;
/** The gap between the button's edge and the first bubble (px). */
const FIRST_GAP = 18;
/** The distance between two bubbles' centres (px). */
const BUBBLE_STEP = 56;
/** The tucked tab's width (px): what is left showing at the edge. */
const TAB_WIDTH = 10;
/** How far down the tucked tab sits within the button's height (px). */
const TAB_INSET = 6;
/** Each bubble follows the one before it by this much as the menu opens (ms). */
const STAGGER_MS = 30;

/** A sub-action as the slot hands it: its component sealed, drawn only
 *  through `renderIsolated`. */
type Action = SealContributions<PhoneActionContribution>;

const NO_ACTIONS: readonly Action[] = [];

/**
 * The phone action button, mounted at `Apps.Overlay`: drawn only on a phone,
 * on the page itself — never inside an `AppEmbed` (it has its own box, inside
 * a page that already has the button) nor in a chromeless document (a
 * companion's panel).
 */
export function PhoneActionButton() {
  const isMobile = useIsMobile();
  const { contained } = useTabs();
  if (!isMobile || contained || isChromelessDocument()) return null;
  return <PhoneActionHost />;
}

function PhoneActionHost() {
  const order = useSlotOrder(PhoneActions.Action);
  const actions: readonly Action[] = foldResource(order, {
    // Actions are offers: while their order is unknown there are none yet.
    loading: () => NO_ACTIONS,
    // A failed read with nothing to fall back on is not "no actions": throw
    // it to the slot's error boundary.
    error: (error, stale) => {
      if (stale) return stale;
      throw error;
    },
    ready: (list) => list,
  });
  const vp = useViewport();
  const [sheet, setSheet] = useState<Action | null>(null);
  // Where focus returns when a sheet closes: the button (the bubble that
  // opened it is hidden by then).
  const fabRef = useRef<HTMLElement>(null);
  if (vp === null || actions.length === 0) return null;
  return (
    <Theme name={chromeThemeScope} surface="none">
      <Fab
        ref={fabRef}
        vp={vp}
        actions={actions}
        away={sheet !== null}
        onPick={setSheet}
      />
      {actions.map((action) => (
        <BottomSheet
          key={action.id}
          title={action.label}
          open={sheet?.id === action.id}
          onClose={() => setSheet(null)}
          finalFocus={fabRef}
        >
          {renderIsolated(
            PhoneActions.Action,
            action as unknown as Contribution,
            { close: () => setSheet(null) },
          )}
        </BottomSheet>
      ))}
    </Theme>
  );
}

interface Press {
  /** Where the press started. */
  sx: number;
  sy: number;
  /** The button's top-left when it started. */
  ox: number;
  oy: number;
  /** Past the drag threshold: a drag, not a tap. */
  moved: boolean;
  /** The button's top-left as of the last move — what a drop snaps from
   *  (the release can arrive before React has rendered that move). */
  left: number;
  top: number;
}

function Fab({
  ref,
  vp,
  actions,
  away,
  onPick,
}: {
  ref: RefObject<HTMLElement | null>;
  vp: Viewport;
  actions: readonly Action[];
  away: boolean;
  onPick: (action: Action) => void;
}) {
  const [place, setPlace] = useFabPlace();
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => setOpen(false), []);
  const { tucked, untuck } = useTuckOnScroll(closeMenu);
  // The button's top-left while it is dragged; null at rest.
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const press = useRef<Press | null>(null);

  const rest = restingPoint(place, vp);
  const at = drag ?? rest;
  const onRight = at.left + FAB_SIZE / 2 > vp.w / 2;
  const goDown = at.top < vp.h / 2;
  const cx = at.left + FAB_SIZE / 2;
  const cy = at.top + FAB_SIZE / 2;

  return (
    // One viewport layer for the scrim, the bubbles and the button: it lets
    // every press through but on what it draws, and each piece is placed in
    // it by runtime numbers.
    <ViewportOverlay className="pointer-events-none">
      {/* The scrim fades in under the open menu; a tap on it closes it. */}
      <div
        aria-hidden
        className={cn(
          layerClasses(),
          "bg-black/60 transition-opacity duration-250",
          open ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        onClick={closeMenu}
      />
      {actions.map((action, i) => {
        // Fanned toward the open side: down from a button in the top half,
        // up from one in the bottom half.
        const dy =
          (goDown ? 1 : -1) *
          (FAB_SIZE / 2 + FIRST_GAP + BUBBLE_STEP * i + BUBBLE / 2);
        const x = onRight
          ? { end: vp.w - cx - BUBBLE / 2 }
          : { start: cx - BUBBLE / 2 };
        const bubble = (
          <Center
            key="bubble"
            as="span"
            className={cn(
              rigidClass(),
              "size-[46px] rounded-full bg-popover text-popover-foreground shadow-[0_6px_18px_#0008]",
            )}
          >
            <Icon icon={action.icon} className="size-5" />
          </Center>
        );
        const label = (
          <Text
            key="label"
            variant="label"
            className={cn(
              insetClass({ x: "sm", y: "xsm" }),
              "rounded-md bg-popover whitespace-nowrap text-popover-foreground shadow-[0_6px_18px_#0008]",
            )}
          >
            {action.label}
          </Text>
        );
        return renderAsContribution(
          PhoneActions.Action,
          action,
          <Stack
            key={action.id}
            as="button"
            direction="row"
            gap="sm"
            align="center"
            aria-label={action.label}
            tabIndex={open ? 0 : -1}
            className={cn(
              placedClasses(),
              "transition-[transform,opacity] duration-[280ms,200ms] ease-[cubic-bezier(.2,.9,.3,1.25)]",
              open ? "pointer-events-auto opacity-100" : "opacity-0",
            )}
            style={{
              ...placedStyle(x, { start: cy + dy - BUBBLE / 2 }),
              ...(open
                ? { transitionDelay: `${i * STAGGER_MS}ms` }
                : { transform: `translateY(${-dy}px) scale(.4)` }),
            }}
            onClick={() => {
              setOpen(false);
              onPick(action);
            }}
          >
            {/* The label on the inner side: after the bubble on the left
                edge, before it on the right. */}
            {onRight ? [label, bubble] : [bubble, label]}
          </Stack>,
        );
      })}
      <Center
        as="button"
        ref={ref}
        aria-label="Actions"
        aria-expanded={open}
        data-phone-action-button=""
        className={cn(
          placedClasses(),
          "pointer-events-auto touch-none bg-primary text-primary-foreground select-none shadow-[0_8px_24px_#0009,inset_0_0_0_1px_#ffffff22]",
          drag
            ? "scale-[1.08] transition-none"
            : "transition-[left,top,transform,scale,width,height,border-radius,opacity] duration-[300ms,300ms,200ms,200ms,250ms,250ms,250ms,250ms] ease-[cubic-bezier(.2,.9,.3,1.2),cubic-bezier(.2,.9,.3,1.2),ease,ease,ease,ease,ease,ease]",
          tucked
            ? "h-[44px] w-[10px] rounded-sm opacity-75"
            : "size-[56px] rounded-full",
          away && "pointer-events-none scale-0 opacity-0",
        )}
        style={placedStyle(
          { start: tucked ? (onRight ? vp.w - TAB_WIDTH : 0) : at.left },
          { start: tucked ? at.top + TAB_INSET : at.top },
        )}
        onPointerDown={(e: ReactPointerEvent<HTMLElement>) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          press.current = {
            sx: e.clientX,
            sy: e.clientY,
            ox: at.left,
            oy: at.top,
            moved: false,
            left: at.left,
            top: at.top,
          };
        }}
        onPointerMove={(e: ReactPointerEvent<HTMLElement>) => {
          const p = press.current;
          if (!p) return;
          const dx = e.clientX - p.sx;
          const dy = e.clientY - p.sy;
          if (!p.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          if (!p.moved) {
            p.moved = true;
            setOpen(false);
          }
          p.left = p.ox + dx;
          p.top = p.oy + dy;
          setDrag({ left: p.left, top: p.top });
        }}
        onPointerUp={() => {
          const p = press.current;
          press.current = null;
          if (!p) return;
          // Tap or drag is decided here, not in a click: a touch that moved
          // gets no click at all on a phone.
          if (p.moved) {
            setDrag(null);
            setPlace(snapPlace(p.left, p.top, vp));
          } else if (tucked) untuck();
          else setOpen((o) => !o);
        }}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
        onClick={(e: ReactMouseEvent<HTMLElement>) => {
          // The keyboard's activation (a pointer's was handled on release).
          if (e.detail !== 0) return;
          if (tucked) untuck();
          else setOpen((o) => !o);
        }}
      >
        <FabGlyph open={open} tucked={tucked} />
      </Center>
    </ViewportOverlay>
  );
}

/** ⋯ at rest, turning into × while the menu is open; nothing on the tab. */
function FabGlyph({ open, tucked }: { open: boolean; tucked: boolean }) {
  // Both glyphs fill the button's box, one fading and turning into the other.
  const swap = cn(
    layerClasses(),
    "transition-[transform,rotate,scale,opacity] duration-[250ms,250ms,250ms,200ms]",
  );
  return (
    <>
      <Center
        as="span"
        className={cn(
          swap,
          open && "scale-50 rotate-90 opacity-0",
          tucked && "opacity-0",
        )}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5.5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="18.5" cy="12" r="2" />
        </svg>
      </Center>
      <Center
        as="span"
        className={cn(
          swap,
          !open && "scale-50 -rotate-90 opacity-0",
          tucked && "opacity-0",
        )}
      >
        <Icon icon={closeIcon} className="size-6" />
      </Center>
    </>
  );
}
