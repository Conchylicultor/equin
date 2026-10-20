import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Demo } from "./slots";

export { Demo, demoResource } from "./slots";
export type { DemoBackend, DemoRoute } from "./slots";

export default {
  description:
    "Demo scenarios (core) and the two slots a plugin answers its own keys in every demo scope through (web): Demo.Resource (a useBackend hook returning a plugin's per-scope backend: a browser server serve function plus endpoint routes sharing its state) and Demo.Route (a stateless [ep.route, implement(ep, handler)]). A leaf: the scope that reads them lives in demo/scope, so a low plugin (config_v2) can contribute without depending on the scope's UI.",
  contributions: [],
  slots: Demo,
} satisfies PluginDefinition;
