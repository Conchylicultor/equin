import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { demoApp } from "../core";
import { DemoLayout } from "./components/demo-layout";
import { demoStartPane } from "./components/demo-start";
import { demoAtPane } from "./components/demo-at";

export default {
  description:
    "App shell for the Demo sandbox: registers the /demo app entry — equin rendered in-process on made-up data (DemoScope + AppEmbed over the workspace demo's browser host), starting on its home app (the app gallery). Where the visitor is inside the demo is the page's URL (/demo/at/<location>, e.g. /demo/at/agents/c/<id>), so a reload comes back to it; ;full=1 shows it full screen instead of framed under the caption bar (its Full screen button; a hover strip at the top edge exits), and a new browser tab opened from inside the demo opens it there, full screen, on the same data.",
  contributions: [
    Apps.App({
      app: demoApp,
      component: DemoLayout,
    }),
    Pane.Register({ pane: demoStartPane }),
    Pane.Register({ pane: demoAtPane }),
  ],
  slots: { start: demoStartPane, at: demoAtPane },
} satisfies PluginDefinition;
