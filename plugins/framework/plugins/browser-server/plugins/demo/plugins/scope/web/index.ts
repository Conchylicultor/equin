import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoScope, useDemoHostControl } from "./components/demo-scope";
export type { DemoBoot, DemoHostControl } from "./components/demo-scope";

export default {
  description:
    "<DemoScope scenario>: renders its subtree against the scenario's browser host — real server code in a worker, on the scenario's seed — and scoped to the host's composition (<PluginScope>), so the page shows exactly the plugins the worker serves. Everything inside reaches the host only (the scope's transport): the build's coverage guard holds the host to serving every read, endpoint and config the scope uses, or declaring it needsMachine (answered unavailable); a key or endpoint it still does not serve fails loudly. A host that fails to boot throws to the error boundary. An optional boot render gates the demo on every visit (DemoBoot: checking, the gate, then starting with the worker's progress): the visitor enters it (enter), or — while they are in the demo in another tab of this browser (a shared Web Lock each such tab holds) — the tab joins it with no gate (onEnter hears both); behind the gate, a browser already holding the demo's data starts the host at once, a first visit only on enter, since it downloads the whole server and its data. Connects to one SharedWorker per build (every tab of the demo shares its server and data), shows why when the host declines the page (data written by a newer version) or stops serving it (another tab took it over), and exposes Reset (useDemoHostControl) — the host wipes its data and every tab reconnects to a fresh one.",
  contributions: [],
} satisfies PluginDefinition;
