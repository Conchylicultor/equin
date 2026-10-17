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
import { usePanelStackState } from "./stack-context";

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
   * Comfort cap on the panel's HEIGHT, from `OverlayPanel`'s closed scale;
   * default `viewport`. A long list wants `lg` so it does not open as a
   * viewport-tall wall.
   *
   * This is not a width prop wearing a hat. Invariant #5 is about WIDTH, and
   * the reason there is no `width` here — three panels in one toolbar at 481,
   * 384 and 256px, each set by whatever was widest inside it — has no height
   * analogue: fitting the viewport and scrolling is already unconditional in
   * `OverlayPanel`, so this only ever makes a panel SHORTER than the space it
   * has. It is a closed scale so there is nowhere to smuggle a measurement
   * through.
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
 * inside it. The width is the bucket the showing page's CONTENT needs
 * (`width-need.ts`), the padding is the panel body's, and there is nowhere to
 * smuggle a measurement through. That is what makes "width is a role"
 * enforceable rather than aspirational: the escape is absent from the type, not
 * defaulted in it.
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
  maxHeight,
  label,
  align = "start",
  side = "bottom",
  open,
  onOpenChange,
  children,
}: ControlPanelPopoverProps) {
  // The stack's state lives HERE rather than inside the stack so it returns to
  // the root once the panel has finished closing — the same fresh start
  // `resetOnClose` gave the stack when it owned its state.
  const stack = usePanelStackState();
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
        // NO width role: the surface's width is its CONTENT's need, collected
        // in CSS from the showing page (`cp-surface` in `app.css`, see
        // `width-need.ts`) — so a page is drawn at the width it needs whoever
        // opened it.
        width="content"
        className="cp-surface"
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
