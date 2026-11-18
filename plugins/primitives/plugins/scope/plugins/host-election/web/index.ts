import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useElectedHost } from "./internal/host-election";

export default {
  description:
    "Which mounted root host of a page-global service runs: useElectedHost(service) — for a `scope: \"each\"` root host whose engine is ONE per page (a hints tour, the background music), mounted at the page root and in every `<PluginScope>`. Every mounted host registers under its service; exactly one is elected: the page's when the page holds the plugin, else the first scope's (the standalone website, which holds the plugin only for its demo's scope). A static render registers nothing and elects no one.",
  contributions: [],
} satisfies PluginDefinition;
