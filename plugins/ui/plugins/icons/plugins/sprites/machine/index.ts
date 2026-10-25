import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { iconManifestServed } from "./internal/manifest";
import { residentSpritesServed } from "./internal/resident";
import { runtimeSymbolsServed } from "./internal/runtime-symbols-value";
import { iconSpriteServed } from "./internal/sprite-value";
import {
  savedIconSpritesServed,
  savedIconsChangedServed,
} from "./internal/saved";

export default {
  description:
    "Builds the icon sprites from the Iconify JSON for the manifest's names — one <svg> of <symbol id=\"ms-<styleKey>-<name>\"> per style key (material-symbols at 400, material-symbols-light at 300) plus a brands sprite — and serves the default style's as the resident icons.sprites value and every one on demand as the icons.sprite value, immutable. Saved (user-picked) icons are runtime symbols: the resident icons.saved-sprites value draws every name a saved-icon source (ui/icons/saved-sources) reports in the default style, and the on-demand icons.runtime-symbols value serves any saved names in any style, immutable. icons.manifest serves the manifest's symbol names (Debug → Icons' rows). Desktop-only (needsMachine): the sprites are built from the icon sets installed on the computer.",
  contributions: [
    ...residentSpritesServed.declare,
    ...iconSpriteServed.declare,
    ...savedIconsChangedServed.declare,
    ...savedIconSpritesServed.declare,
    ...iconManifestServed.declare,
    ...runtimeSymbolsServed.declare,
  ],
} satisfies MachinePluginDefinition;
