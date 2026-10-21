import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoScope } from "./components/demo-scope";

export default {
  description:
    "<DemoScope scenario>: renders its subtree against the scenario's browser host — real server code in a worker, on the scenario's seed — and scoped to the host's composition (<PluginScope>), so the page shows exactly the plugins the worker serves. A key the host does not serve fails loader-failed naming it; an /api request it refuses as unsupported shows one deduped 'Not available in the demo' toast; a host that fails to boot throws to the error boundary.",
  contributions: [],
} satisfies PluginDefinition;
