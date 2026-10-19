import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  clearMapsBrowserConfig,
  clearMapsMapId,
  setMapsBrowserConfig,
  setMapsMapId,
} from "../core";
import {
  handleClearBrowserConfig,
  handleClearMapId,
  handleSetBrowserConfig,
  handleSetMapId,
  mapsBrowserConfigServed,
  mapsBrowserConfigWatcher,
} from "./internal/browser-config-resource";

export { getPlacesClient, type PlacesClientResult } from "./internal/key";

export default {
  description:
    "Google Maps Platform access broker (server): getPlacesClient() hands out the metered Places client (the stored Places API key, read via the shared auth/central store, plus the usage ledger's meter), so consumers never import @plugins/auth and no Places call goes uncounted; serves the host-global public browser config (Maps JavaScript API key) as a live value, with its write/clear endpoints for the key and the vector map's Map ID.",
  contributions: [...mapsBrowserConfigServed.declare],
  register: [mapsBrowserConfigWatcher],
  httpRoutes: {
    [setMapsBrowserConfig.route]: handleSetBrowserConfig,
    [clearMapsBrowserConfig.route]: handleClearBrowserConfig,
    [setMapsMapId.route]: handleSetMapId,
    [clearMapsMapId.route]: handleClearMapId,
  },
} satisfies ServerPluginDefinition;
