import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoScope } from "./components/demo-scope";

export default {
  description:
    "<DemoScope scenario>: renders its subtree against a browser server of its own: the scenario's browser host (real server code in a worker, on the scenario's seed), every Demo.Resource contribution's serves and routes (a plugin answering its own live keys, e.g. config from code defaults). Any other live key fails loader-failed; any other /api request is refused as unsupported with one deduped 'Not available in the demo' toast; a host that fails to boot, or a key served twice, throws to the error boundary.",
  contributions: [],
} satisfies PluginDefinition;
