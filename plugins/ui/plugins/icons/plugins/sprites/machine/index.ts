import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { runtimeSymbolsEndpoint, spriteEndpoint } from "../core";
import { handleRuntimeSymbols } from "./internal/handle-runtime-symbols";
import { handleSprite } from "./internal/handle-sprite";
import { residentSpritesServed } from "./internal/resident";
import {
  savedIconSpritesServed,
  savedIconsChangedServed,
} from "./internal/saved";

export default {
  description:
    "Builds the icon sprites from the Iconify JSON for the manifest's names — one <svg> of <symbol id=\"ms-<styleKey>-<name>\"> per style key (material-symbols at 400, material-symbols-light at 300) plus a brands sprite — and serves the default style's as the resident icons.sprites value and every one at GET /api/icons/sprite/:hash/:key, immutable. Saved (user-picked) icons are runtime symbols: the resident icons.saved-sprites value draws every name a saved-icon source (ui/icons/saved-sources) reports in the default style, and GET /api/icons/symbols/:hash/:key?names= serves any saved names in any style, immutable. Desktop-only (needsMachine): the sprites are built from the icon sets installed on the computer.",
  contributions: [
    ...residentSpritesServed.declare,
    ...savedIconsChangedServed.declare,
    ...savedIconSpritesServed.declare,
  ],
  httpRoutes: {
    [spriteEndpoint.route]: machineHandler(spriteEndpoint, handleSprite),
    [runtimeSymbolsEndpoint.route]: machineHandler(
      runtimeSymbolsEndpoint,
      handleRuntimeSymbols,
    ),
  },
} satisfies MachinePluginDefinition;
