import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DemoScope } from "./components/demo-scope";

export default {
  description:
    "<DemoScope scenario>: renders its subtree against a browser server of its own, built once the scenario's pack loads — the pack's recorded answers, every Demo.Resource contribution's serves (a plugin answering its own live keys, e.g. config from code defaults) and every Demo.Route handler. Any other live key fails loader-failed; any other /api request is refused as unsupported with one deduped 'Not available in the demo' toast; a pack that fails to parse, or a key served twice, throws to the error boundary.",
  contributions: [],
} satisfies PluginDefinition;
