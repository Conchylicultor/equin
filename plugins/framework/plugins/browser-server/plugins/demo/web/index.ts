import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Demo } from "./slots";

export { Demo, demoResource } from "./slots";
export type { DemoServe } from "./slots";

export default {
  description:
    "Demo packs (core) and the two slots a plugin answers its own keys in every demo scope through (web): Demo.Resource (a useServe hook returning a browser server serve function) and Demo.Route ([ep.route, implement(ep, handler)]). A leaf: the scope that reads them lives in demo/scope, so a low plugin (config_v2) can contribute without depending on the scope's UI.",
  contributions: [],
  slots: Demo,
} satisfies PluginDefinition;
