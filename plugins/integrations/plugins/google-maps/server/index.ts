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

export { getMapsKey, type MapsKeyResult } from "./internal/key";

export default {
  description:
    "Google Maps Platform access broker (server): getMapsKey() reads the stored Places API key via the shared auth/central store, so consumers never import @plugins/auth; serves the host-global public browser config (Maps JavaScript API key) as a live value, with its write/clear endpoints for the key and the vector map's Map ID.",
  contributions: [...mapsBrowserConfigServed.declare],
  register: [mapsBrowserConfigWatcher],
  httpRoutes: {
    [setMapsBrowserConfig.route]: handleSetBrowserConfig,
    [clearMapsBrowserConfig.route]: handleClearBrowserConfig,
    [setMapsMapId.route]: handleSetMapId,
    [clearMapsMapId.route]: handleClearMapId,
  },
} satisfies ServerPluginDefinition;
