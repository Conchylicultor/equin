import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoBootScreen } from "./components/demo-boot-screen";
export { ResetDemoButton, RestoreStrip } from "./components/demo-controls";

export default {
  description:
    "The demo before it runs, drawn for <DemoScope boot>: the equin logo over the logo's own colours, then at the gate the Enter equin button (a first visit downloads nothing before it), and while the host starts one bar in the logo's gradient — what it is doing and how much it downloaded, weighed from the worker's progress (the starting data, then the plugins loaded). Also the demo's two controls: Reset demo (confirmed; the host wipes its data and every tab starts again from the story) and the Restore strip of a maximized demo (revealed by the pointer at the page's top edge). Shared by /demo and the website's demo band.",
  contributions: [],
} satisfies PluginDefinition;
