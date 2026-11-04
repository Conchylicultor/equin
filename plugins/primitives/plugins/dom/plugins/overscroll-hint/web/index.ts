import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { OverscrollHintController } from "./internal/overscroll-hint-controller";

export default {
  description:
    "Wasted-scroll hint: a single invisible global controller (mounted via Core.Root) that plays a small native-feeling rubber-band bounce on a surface when a wheel/trackpad/touch gesture scrolls nothing (not scrollable, or already at the edge). Gestures are batched per frame and a batch is wasted when no scroller on its chain scrolled or has room left; a two-stage physics (a saturating pull, drawn through a critically damped spring) turns bursty trackpad input into one smooth out-and-back.",
  contributions: [Core.Root({ component: OverscrollHintController })],
} satisfies PluginDefinition;
