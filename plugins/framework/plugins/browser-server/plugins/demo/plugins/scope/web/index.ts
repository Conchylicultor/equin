import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoScope } from "./components/demo-scope";

export default {
  description:
    "<DemoScope scenario>: renders its subtree against the scenario's browser host — real server code in a worker, on the scenario's seed — and scoped to the host's composition (<PluginScope>), so the page shows exactly the plugins the worker serves. Everything inside reaches the host only (the scope's transport): the build's coverage guard holds the host to serving every read, endpoint and config the scope uses, or declaring it needsMachine (answered unavailable); a key or endpoint it still does not serve fails loudly. A host that fails to boot throws to the error boundary.",
  contributions: [],
} satisfies PluginDefinition;
