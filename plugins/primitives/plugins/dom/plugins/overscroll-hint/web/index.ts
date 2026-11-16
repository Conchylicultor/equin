import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { OverscrollHintController } from "./internal/overscroll-hint-controller";

export default {
  description:
    "Wasted-scroll hint: a single invisible global controller (mounted via Core.Root) that plays a small native-feeling rubber-band bounce on a surface when a wheel/trackpad/touch gesture scrolls nothing (not scrollable, or already at the edge). Gestures are batched per frame and a batch is wasted when no scroller on its chain scrolled or has room left; a two-stage physics (a saturating pull, drawn through a critically damped spring) turns bursty trackpad input into one smooth out-and-back. A touch pulling down past the top is the phone's pull to refresh instead: the page stays put, a disc drops in from the top edge and letting go once it is armed reloads the page (left to the browser when the page scrolls as a document). A touch the page claimed with touch-action (a dial, a slider) is never a wasted scroll; and the touch-claim guard enforces the claim — a setPointerCapture on a touch whose touch-action still lets the browser pan both ways is reported (UnclaimedTouchDragError), since the browser would take that drag.",
  contributions: [
    Core.Root({ component: OverscrollHintController, scope: "page" }),
  ],
} satisfies PluginDefinition;
