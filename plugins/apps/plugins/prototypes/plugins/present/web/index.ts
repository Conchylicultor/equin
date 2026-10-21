import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  PrototypeDetailWrap,
  PrototypeFrameActions,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { FullScreenAction } from "./components/full-screen-action";
import { OpenNewTabAction } from "./components/open-new-tab-action";
import { PresentationHost } from "./components/presentation";
import { prototypePresentPane } from "./panes";

export default {
  description:
    "Two frame actions on every prototype canvas frame: Open in a new tab (the frame's chromeless present page at the Responsive size, filling the tab at its own width; a source frame opens its own href) and Full screen (F, which presents the selected frame; the browser's Fullscreen API). While presenting, hovering shows the frame's tag with its version stepper and 'i of n', Exit, the options pill and the size & zoom chip, on the right edge + (add a frame) and Compare with each resolved frame source (the real app, swiped) — both adding the frame and leaving to the prototype's canvas in the app — and the left and right arrow keys flip through the canvas's frames. The new tab is present/<id>/<sha|live>/<declared|size word>/<picks?>, a one-frame page carrying the frame's version and own picks, with an Exit icon back to the prototype's canvas; its + / Compare open the app's canvas on the frame plus the new one.",
  contributions: [
    Pane.Register({ pane: prototypePresentPane }),
    PrototypeDetailWrap({ id: "presentation", component: PresentationHost }),
    PrototypeFrameActions({ id: "open-new-tab", component: OpenNewTabAction }),
    PrototypeFrameActions({ id: "full-screen", component: FullScreenAction }),
  ],
  slots: {
    "prototypes-present": prototypePresentPane,
  },
} satisfies PluginDefinition;
