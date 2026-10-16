import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  type PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";
import type { ComponentProps } from "react";

import { ControlPanel } from "./control-panel";
import { ControlPanelHostProvider, type ControlPanelHost } from "./host";
import { ControlPanelStack } from "./panel-stack";
import { usePanelStackState, type PanelStackEntry } from "./stack-context";
import type { ControlPanelSize } from "./size";

type Positioning = Pick<
  ComponentProps<typeof PopoverContent>,
  "align" | "side"
>;

/**
 * What the panel hangs off. Usually its own `trigger`, whose click opens and
 * closes it. `anchor` is the other arm, for a panel opened from somewhere
 * else — a menu row whose menu closes as the panel opens — and positioned
 * against an element that is already another popup's trigger. One element
 * cannot be the trigger of two popups without one click opening both, so the
 * panel takes that element as a position only and the caller owns `open`.
 */
type Anchoring =
  | {
      /** The trigger element — open/close is merged in via base-ui's render prop. */
      trigger: React.ReactElement;
      anchor?: never;
    }
  | {
      trigger?: never;
      /** The element the panel is positioned against; nothing opens it by click. */
      anchor: React.RefObject<Element | null>;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    };

export type ControlPanelPopoverProps = Positioning &
  Anchoring &
  ControlPanelPopoverOwnProps;

interface ControlPanelPopoverOwnProps {
  /**
   * The ROOT page's width role: `menu` for a list of choices, `described` for
   * choices with visible description lines, `builder` for a rule row, `picker`
   * for a panel whose body is a grid (swatches, icons, covers). A page pushed
   * onto the panel's stack may declare its own (`PanelStackEntry.size`) — a
   * 248px menu whose Filter row opens the 524px builder — and the panel takes
   * the width of whichever page is showing. There is no width, padding or
   * content-class prop — see below.
   */
  size?: ControlPanelSize;
  /**
   * Comfort cap on the panel's HEIGHT, from `OverlayPanel`'s closed scale;
   * default `viewport`. A long list wants `lg` so it does not open as a
   * viewport-tall wall.
   *
   * This is not the width prop wearing a hat. Invariant #5 is about WIDTH, and
   * the reason there is no `width` here — three panels in one toolbar at 481,
   * 384 and 256px, each set by whatever was widest inside it — has no height
   * analogue: fitting the viewport and scrolling is already unconditional in
   * `OverlayPanel`, so this only ever makes a panel SHORTER than the space it
   * has. It is a closed scale for the same reason `size` is: there is nowhere to
   * smuggle a measurement through.
   */
  maxHeight?: PopoverMaxHeight;
  /** Names the panel for assistive tech. */
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * The sanctioned way to open a control panel.
 *
 * What it does NOT have is the point: no `width`, no `padding`, no
 * `contentClassName`. (`maxHeight` IS here — a cap on height is not a width
 * measurement, and the panel already fits the viewport unconditionally; see the
 * prop.) Those are exactly the props that let three panels in one
 * toolbar end up 481, 384 and 256 pixels wide — each set by whatever was widest
 * inside it. `size` maps to a width ROLE, the padding is the panel body's, and
 * there is nowhere to smuggle a measurement through. That is what makes "width
 * is a role" enforceable rather than aspirational: the escape is absent from the
 * type, not defaulted in it.
 *
 * There is no `tooltip` prop either — the caller's trigger (typically an
 * `IconButton`) already owns its tooltip, and a second one here would be a
 * second source for the same string.
 *
 * The children are wrapped in a `ControlPanel.Stack`, so `usePanelStack()` works
 * inside ANY panel opened this way. A sub-panel is then a push, never a popover
 * opened from inside a popover.
 *
 * …which is also the host policy it publishes: a `Group` here PUSHES, and a
 * description here is a `hint`. A popover passes field subsets precisely because
 * it wants short labels rather than prose, so a paragraph in one is already the
 * wrong surface for the paragraph.
 */
export function ControlPanelPopover({
  trigger,
  anchor,
  size = "menu",
  maxHeight,
  label,
  align = "start",
  side = "bottom",
  open,
  onOpenChange,
  children,
}: ControlPanelPopoverProps) {
  // The stack's state lives HERE rather than inside the stack, because the
  // width is the SURFACE's and the surface is this component's: the showing
  // page's role has to reach `PopoverContent` in the same render that shows
  // the page. It returns to the root once the panel has finished closing —
  // the same fresh start `resetOnClose` gave the stack when it owned its state.
  const stack = usePanelStackState();
  const width = showingSize(stack.entries, size);
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) stack.reset();
      }}
    >
      {trigger ? <PopoverTrigger render={trigger} /> : null}
      <PopoverContent
        resetOnClose
        anchor={anchor}
        align={align}
        side={side}
        width={width}
        maxHeight={maxHeight}
        padding="none"
      >
        <ControlPanel aria-label={label}>
          <ControlPanelHostProvider host={POPOVER_HOST}>
            <ControlPanelStack root={children} state={stack} />
          </ControlPanelHostProvider>
        </ControlPanel>
      </PopoverContent>
    </Popover>
  );
}

const POPOVER_HOST: ControlPanelHost = {
  nesting: "push",
  inlineDepth: 0,
  descriptions: "hint",
};

/** The showing page's width role: the top entry's, where an `"inherit"` entry
 *  takes the role of the page it was pushed from — so a sub-page of a builder
 *  stays builder-wide instead of snapping back to the root panel's role. */
function showingSize(
  entries: readonly PanelStackEntry[],
  root: ControlPanelSize,
): ControlPanelSize {
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = entries[i]!.size;
    if (size !== "inherit") return size;
  }
  return root;
}
