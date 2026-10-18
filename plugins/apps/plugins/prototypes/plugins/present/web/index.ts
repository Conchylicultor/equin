import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  PrototypeFrameActions,
  prototypeDetailPane,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { OpenResponsiveAction } from "./components/open-responsive-action";
import { PresentMenu } from "./components/present-menu";
import { OpenCanvasAction } from "./components/open-canvas-action";
import { prototypePresentCanvasPane, prototypePresentPane } from "./panes";

export default {
  description:
    "Present one canvas frame without the app around it: a per-frame Present menu (a frame action) with In this app tab (the tab bar stays), In this browser tab plus a new-browser-tab icon, and Full screen (F, which presents the selected frame); beside it, an Open responsive in a new tab button (the chromeless present page at the Responsive size, filling the tab at its own width). While presenting, hovering shows the frame's tag with its version stepper and 'i of n', Exit, the options pill and the size & zoom chip, and the left and right arrow keys flip through the canvas's frames. A new tab opens present/<id>/<sha|live>/<declared|size word>/<picks?>, a one-frame page carrying the frame's version and own picks. In the canvas header, Open the canvas in a new tab opens the whole canvas (frames, versions, picks, size, zoom, layout, encoded in present-canvas/<id>/<canvas>) chromeless in a new browser tab, so the frames get the whole screen to compare.",
  contributions: [
    Pane.Register({ pane: prototypePresentPane }),
    Pane.Register({ pane: prototypePresentCanvasPane }),
    prototypeDetailPane.Actions({
      id: "open-canvas",
      component: OpenCanvasAction,
    }),
    PrototypeFrameActions({ id: "present", component: PresentMenu }),
    PrototypeFrameActions({
      id: "open-responsive",
      component: OpenResponsiveAction,
    }),
  ],
  slots: {
    "prototypes-present": prototypePresentPane,
    "prototypes-present-canvas": prototypePresentCanvasPane,
  },
} satisfies PluginDefinition;
