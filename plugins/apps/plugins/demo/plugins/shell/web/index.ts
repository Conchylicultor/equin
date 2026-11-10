import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { demoApp } from "../core";
import { DemoLayout } from "./components/demo-layout";
import { demoStartPane } from "./components/demo-start";
import { demoAtPane } from "./components/demo-at";

export default {
  description:
    "App shell for the Demo sandbox: registers the /demo app entry — equin rendered in-process on made-up data (DemoScope + AppEmbed over the workspace demo's browser host), starting on its home app (the app gallery). Where the visitor is inside the demo is the page's URL (/demo/at/<location>, e.g. /demo/at/agents/c/<id>), so a reload comes back to it; ;full=1 shows it maximized instead of framed under the caption bar (its Maximize button; a hover strip at the top edge reveals Restore, and Esc restores when nothing inside the demo wants it — both run as a view transition, and a 'Press Esc to restore' notice shows a few seconds), and a new browser tab opened from inside the demo opens it there, maximized, on the same data — with no second Enter equin, since the visitor is in the demo already. A maximized URL opened fresh (a reload) shows its gate maximized, so Enter opens the demo in place. Maximized, the demo is the tab: its moves are history entries (Back / Forward step through them, the embed following the URL); framed, they rewrite the current entry, so Back leaves the page.",
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
