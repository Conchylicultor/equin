import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoBootScreen } from "./components/demo-boot-screen";
export { ResetDemoButton } from "./components/demo-controls";
export { BackToSitePill } from "./components/back-to-site-pill";
export { DEMO_FRAME_ATTR, morphDemoFrame } from "./internal/maximize-morph";

export default {
  description:
    "The demo before it runs, drawn for <DemoScope boot>: the equin logo over the logo's own colours, then the Enter equin button on every visit (a first visit downloads nothing before it; a return visit's host already starts behind it; the homepage frame shows it even while the visitor is in the demo in another tab, Enter joining that same shared demo; only the demo page, whose URL names a place in it, opens with no gate), drawn in the frame or maximized where the URL is, and once entered, while the host starts, one bar in the logo's gradient — what it is doing and how much it downloaded, weighed from the worker's progress (the starting data, then the plugins loaded). Also the demo's controls: Reset demo (confirmed; the host wipes its data and every tab starts again from the story), and the demo page's way back — BackToSitePill: an always-shown, draggable pill at the top edge ('Demo · made-up data', Back to equin; only the button on a narrow screen) — with Maximize / Back run as a view transition (morphDemoFrame: the demo's box grows to the tab's surface and shrinks back). Drawn by the website.s demo band.",
  contributions: [],
} satisfies PluginDefinition;
