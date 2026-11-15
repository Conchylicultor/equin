import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { LiveDemoSection } from "./components/live-demo-section";

export default {
  description:
    "Landing demo band: equin itself, live, where the desktop picture was — a frame claimed for the site's live demo (live-demo's DemoTarget: its server is the site's resident, so it outlives the page), entered through Enter equin on every visit (a first visit downloads nothing before it; a browser already holding the data starts the host behind it). Entering grows the frame in place for good, nearly as wide and tall as the window; once it runs, Maximize (the demo page /about/demo, as a view transition) and Reset demo sit under it. The homepage's URL never names the demo: the framed demo's place is kept in memory, and coming back from the demo page shows the frame grown at that place, scrolled to.",
  contributions: [
    Website.Section({
      id: "screenshot",
      label: "Demo",
      component: LiveDemoSection,
    }),
  ],
} satisfies PluginDefinition;
