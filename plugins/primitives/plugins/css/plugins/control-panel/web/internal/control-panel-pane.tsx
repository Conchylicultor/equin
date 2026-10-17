import type React from "react";

import { ControlPanel } from "./control-panel";
import { ControlPanelHostProvider, type ControlPanelHost } from "./host";
import { ControlPanelStack } from "./panel-stack";

export interface ControlPanelPaneProps {
  /** Names the panel for assistive tech, exactly as `ControlPanel` does. */
  label?: string;
  children: React.ReactNode;
  // NO width. NO padding. NO size. The same absences as `ControlPanelPopover`,
  // for the same reason — the escape is MISSING from the type, not defaulted in
  // it. A pane's width is the pane system's (`Pane.define({ width })`) — a pane
  // does not read its content's `data-cp-needs` the way the popover surface
  // does — and it does not move as the content changes. Invariant #5 survives intact; what must never
  // appear is a width prop on the panel BODY, and there is none here.
}

/**
 * The panel body as a PANE's contents — the second surface in the vocabulary,
 * beside `ControlPanelPopover`.
 *
 * It owns exactly three things and nothing else:
 *
 *  - The body (`ControlPanel`), which publishes the rail. It is the SAME rail
 *    the popover path publishes, and that is what makes a settings pane and a
 *    filter popover line up pixel for pixel rather than merely look similar.
 *  - The `ControlPanel.Stack`, so `usePanelStack()` works and deep nesting has
 *    somewhere to go — a `Group` past the inline budget pushes rather than
 *    collapsing into nothing.
 *  - The host policy: inline the first level of nesting, and put descriptions on
 *    the band. Measured across the repo, most config descriptions are real
 *    paragraphs; behind a hover they would be invisible on touch, unreachable by
 *    ⌘F and gone for anyone reading down the pane.
 *
 * It owns NEITHER the scroll NOR the width. `PaneChrome`'s scroller is already
 * the scroller, and a second one inside a pane is the bug this avoids. It must
 * not import `primitives/pane` either — that inverts the layer, and this is a
 * body, a stack and a context value.
 */
export function ControlPanelPane({ label, children }: ControlPanelPaneProps) {
  return (
    <ControlPanel aria-label={label}>
      <ControlPanelHostProvider host={PANE_HOST}>
        <ControlPanelStack root={children} />
      </ControlPanelHostProvider>
    </ControlPanel>
  );
}

const PANE_HOST: ControlPanelHost = {
  nesting: "inline",
  inlineDepth: 1,
  descriptions: "band",
};
