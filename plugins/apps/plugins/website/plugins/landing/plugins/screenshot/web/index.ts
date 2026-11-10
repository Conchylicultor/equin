import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { LiveDemoSection } from "./components/live-demo-section";

export default {
  description:
    "Landing demo band: equin itself, live, where the desktop picture was — its real server code in a worker on the workspace demo's data (DemoScope around AppEmbed), downloaded only when the visitor clicks Enter equin (a browser already holding the data starts it at once). Entering grows the frame in place, nearly as wide and tall as the window; once it runs, Maximize (the tab's surface, above the site; Restore at its top edge), Collapse / Expand and Reset demo sit under it.",
  contributions: [
    Website.Section({
      id: "screenshot",
      label: "Demo",
      component: LiveDemoSection,
    }),
  ],
} satisfies PluginDefinition;
