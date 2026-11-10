import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoBootScreen } from "./components/demo-boot-screen";
export { ResetDemoButton } from "./components/demo-controls";
export { MaximizedChrome } from "./components/maximized-chrome";
export { DEMO_FRAME_ATTR, morphDemoFrame } from "./internal/maximize-morph";

export default {
  description:
    "The demo before it runs, drawn for <DemoScope boot>: the equin logo over the logo's own colours, then the Enter equin button on every visit (a first visit downloads nothing before it; a return visit's host already starts behind it; a tab opened while the visitor is in the demo elsewhere joins it with no gate), drawn in the frame or maximized where the URL is, and once entered, while the host starts, one bar in the logo's gradient — what it is doing and how much it downloaded, weighed from the worker's progress (the starting data, then the plugins loaded). Also the demo's controls: Reset demo (confirmed; the host wipes its data and every tab starts again from the story), and the maximized demo's chrome — the Restore strip (revealed by the pointer at the page's top edge), a 'Press Esc to restore' notice that hides on its own, and Esc itself (page-wide, the lowest precedence: only when nothing inside the demo wants the key) — with Maximize / Restore run as a view transition (morphDemoFrame: the demo's box grows to the tab's surface and shrinks back). Shared by /demo and the website's demo band.",
  contributions: [],
} satisfies PluginDefinition;
