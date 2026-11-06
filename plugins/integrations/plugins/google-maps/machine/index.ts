import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  clearMapsBrowserConfig,
  clearMapsMapId,
  setMapsBrowserConfig,
  setMapsMapId,
} from "../core";
import { MapsBrowserConfigSource } from "../server";
import {
  browserConfigFile,
  handleClearBrowserConfig,
  handleClearMapId,
  handleSetBrowserConfig,
  handleSetMapId,
  mapsBrowserConfigWatcher,
} from "./internal/browser-config-file";

export { getPlacesClient, type PlacesClientResult } from "./internal/key";

export default {
  description:
    "Google Maps Platform access broker, desktop half: getPlacesClient() hands out the metered Places client (the stored Places API key, read via the shared auth/central store, plus the usage ledger's meter), so consumers never import @plugins/auth and no Places call goes uncounted; provides MapsBrowserConfigSource from the host-global browser-config file (watched while a tab reads it), with the write/clear endpoints for the key and the vector map's Map ID (needsMachine).",
  register: [mapsBrowserConfigWatcher],
  contributions: [MapsBrowserConfigSource.provide(browserConfigFile)],
  httpRoutes: {
    [setMapsBrowserConfig.route]: handleSetBrowserConfig,
    [clearMapsBrowserConfig.route]: handleClearBrowserConfig,
    [setMapsMapId.route]: handleSetMapId,
    [clearMapsMapId.route]: handleClearMapId,
  },
} satisfies MachinePluginDefinition;
