import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { LiveDemoSection } from "./components/live-demo-section";

export default {
  description:
    "Landing demo band: equin itself, live, where the desktop picture was — its real server code in a worker on the workspace demo's data (DemoScope around AppEmbed), entered through Enter equin on every visit (a first visit downloads nothing before it; a browser already holding the data starts the host behind it). Entering grows the frame in place for good, nearly as wide and tall as the window; once it runs, Maximize (a view transition over the tab's surface, above the site; Restore at its top edge, a 'Press Esc to restore' notice, Esc) and Reset demo sit under it. Where the visitor is inside the demo, and whether it is maximized, is the homepage's URL (two surface view keys of the landing pane), following /demo's history rule: framed, moves rewrite the current entry; maximized, they are the tab's history.",
  contributions: [
    Website.Section({
      id: "screenshot",
      label: "Demo",
      component: LiveDemoSection,
    }),
  ],
} satisfies PluginDefinition;
