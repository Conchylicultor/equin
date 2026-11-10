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
import { mapsDeploySecretLocalValues } from "./internal/local-values";

export default {
  description:
    "The Maps browser config on the computer: provides MapsBrowserConfigSource from a deployed box's approved GOOGLE_MAPS_BROWSER_KEY deploy secret, else the host-global browser-config file (watched while a tab reads it), with the write/clear endpoints for the key and the vector map's Map ID (needsMachine). Names the file's key and Map ID as the computer's counterparts of the GOOGLE_MAPS_BROWSER_KEY / GOOGLE_MAPS_MAP_ID deploy secrets (DeploySecrets.LocalValue), which the Deploy app offers as Use this computer's value.",
  register: [mapsBrowserConfigWatcher],
  contributions: [
    MapsBrowserConfigSource.provide(browserConfigFile),
    ...mapsDeploySecretLocalValues,
  ],
  httpRoutes: {
    [setMapsBrowserConfig.route]: handleSetBrowserConfig,
    [clearMapsBrowserConfig.route]: handleClearBrowserConfig,
    [setMapsMapId.route]: handleSetMapId,
    [clearMapsMapId.route]: handleClearMapId,
  },
} satisfies MachinePluginDefinition;
