import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  type PopoverMaxHeight,
  type PopoverPadding,
  type PopoverWidth,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createHoverIntent } from "../../core";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

const DEFAULT_OPEN_DELAY = 120;
const DEFAULT_CLOSE_DELAY = 200;

/** What a keyboard user lands on when the panel opens (or is entered) by ArrowDown. */
const FIRST_TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** How the panel came to be open — decides whether opening moves focus. */
type OpenedBy = "hover" | "keyboard" | "touch";

type ContentPositionerProps = Pick<
  ComponentProps<typeof PopoverContent>,
  "align" | "side" | "sideOffset"
>;

/** What the panel's content can do to the popover it sits in. */
export interface HoverPopoverApi {
  /** Close the panel — after an item inside it acted (navigated, picked). */
  close(): void;
}

export interface HoverPopoverProps extends ContentPositionerProps {
  /**
   * The trigger control. Its own click is left alone — "click acts, hover
   * previews" — so a trigger that navigates keeps navigating. The one
   * exception is touch, which has no hover: the first tap on a closed trigger
   * opens the panel instead of clicking, and the next tap clicks.
   *
   * Rendered through base-ui's `render`, so it must be (or forward its props
   * and ref to) a native `<button>`.
   */
  trigger: ReactElement;
  /** The panel's content, or a function of the {@link HoverPopoverApi}. */
  content: ReactNode | ((api: HoverPopoverApi) => ReactNode);
  /** The panel's accessible name. */
  label: string;
  /** How long the pointer rests on the trigger before the panel opens (ms). */
  openDelay?: number;
  /**
   * The grace after the pointer leaves BOTH the trigger and the panel before it
   * closes (ms) — long enough to cross the gap between them.
   */
  closeDelay?: number;
  /** Width role forwarded to PopoverContent; default size-to-content. */
  width?: PopoverWidth;
  /** Padding role forwarded to PopoverContent; default `md`. */
  padding?: PopoverPadding;
  /** Max-height comfort cap forwarded to PopoverContent; default `viewport`. */
  maxHeight?: PopoverMaxHeight;
  /** Extra classes forwarded to PopoverContent (never width / padding / max-height). */
  contentClassName?: ClassName;
}

/**
 * A popover revealed by HOVER rather than by click: the pointer resting on the
 * trigger opens it (after `openDelay`), and it closes once the pointer has been
 * off both the trigger and the panel for `closeDelay` — the panel is portaled
 * away from the trigger, so both are hover zones of one intent.
 *
 * Also opened by ArrowDown on the focused trigger (focus moves to the panel's
 * first control), and by a first tap on touch. Closed by Esc (focus returns to
 * the trigger), an outside press, or focus leaving the panel. The trigger's
 * own click is never intercepted on a pointer with hover, so a trigger can
 * navigate on click and preview on hover at once.
 *
 * Built on the controlled ui-kit `Popover`: base-ui owns positioning, the
 * portal, outside-press / Esc / focus-out dismissal and focus return; this
 * component owns only WHEN it is open. A click on the trigger never toggles it.
 */
export function HoverPopover({
  trigger,
  content,
  label,
  openDelay = DEFAULT_OPEN_DELAY,
  closeDelay = DEFAULT_CLOSE_DELAY,
  side = "bottom",
  align = "start",
  sideOffset,
  width,
  padding,
  maxHeight,
  contentClassName,
}: HoverPopoverProps) {
  const [open, setOpen] = useState(false);
  const [openedBy, setOpenedBy] = useState<OpenedBy>("hover");
  // The pointer that pressed the trigger, read by the click that follows it: a
  // click event does not reliably carry its pointer type across browsers.
  const pressedWith = useRef("");
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();

  const intent = useMemo(
    () =>
      createHoverIntent({
        openDelay,
        closeDelay,
        onOpen: () => {
          setOpenedBy("hover");
          setOpen(true);
        },
        onClose: () => setOpen(false),
      }),
    [openDelay, closeDelay],
  );
  useEffect(() => () => intent.cancel(), [intent]);

  const openWith = (by: OpenedBy) => {
    intent.cancel();
    setOpenedBy(by);
    setOpen(true);
  };
  const close = () => {
    intent.cancel();
    setOpen(false);
  };

  const onZoneEnter = (e: PointerEvent) => {
    if (e.pointerType !== "touch") intent.enter();
  };
  const onZoneLeave = (e: PointerEvent) => {
    if (e.pointerType !== "touch") intent.leave();
  };

  return (
    <Popover
      open={open}
      triggerId={triggerId}
      onOpenChange={(next, details) => {
        // The trigger's click is its own action, never a toggle.
        if (details.reason === "trigger-press") return;
        // Nothing else opens it: every open goes through `openWith`/the intent.
        if (!next) close();
      }}
    >
      <PopoverTrigger
        id={triggerId}
        render={trigger}
        onPointerEnter={onZoneEnter}
        onPointerLeave={onZoneLeave}
        onPointerDown={(e: PointerEvent) => {
          pressedWith.current = e.pointerType;
        }}
        onClickCapture={(e: MouseEvent) => {
          const touch = pressedWith.current === "touch";
          pressedWith.current = "";
          if (touch && !open) {
            // Touch has no hover: the first tap reveals instead of clicking.
            // Stopped in the capture phase, so the trigger's own onClick (and
            // base-ui's) never sees it.
            e.preventDefault();
            e.stopPropagation();
            openWith("touch");
            return;
          }
          // The click acts (navigates); the preview has done its job.
          close();
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          if (open) {
            // Already open by hover: move into it rather than reopening.
            focusElement(
              popupRef.current?.querySelector<HTMLElement>(FIRST_TABBABLE),
              { reveal: false },
            );
            return;
          }
          openWith("keyboard");
        }}
      />
      <PopoverContent
        ref={popupRef}
        aria-label={label}
        side={side}
        align={align}
        sideOffset={sideOffset}
        width={width}
        padding={padding}
        maxHeight={maxHeight}
        className={contentClassName}
        // A hover or touch open must not steal focus from wherever it is; a
        // keyboard open lands on the panel's first control.
        initialFocus={() => openedBy === "keyboard"}
        // Back to the trigger only when the panel was left by keyboard (Esc);
        // an outside click or a hover-out leaves focus where it went.
        finalFocus={(closeType) => closeType === "keyboard"}
        onPointerEnter={onZoneEnter}
        onPointerLeave={onZoneLeave}
      >
        {typeof content === "function" ? content({ close }) : content}
      </PopoverContent>
    </Popover>
  );
}
