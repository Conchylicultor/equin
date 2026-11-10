import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { MapsBrowserConfigSource } from "@plugins/integrations/plugins/google-maps/plugins/browser-config/server";
import { pageBrowserConfig } from "./internal/source";

export default {
  description:
    "The Maps browser config of a browser host: provides the MapsBrowserConfigSource host service from the page around the host — the key the real app already sends that page, handed over by the page's chrome as a page input (never read from a server by the host's own code, never stored). A page that supplies none reads as unset, so the map shows its set-up state, whose writes need the computer. Never booted by the desktop.",
  contributions: [MapsBrowserConfigSource.provide(pageBrowserConfig)],
} satisfies ServerPluginDefinition;
