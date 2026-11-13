import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getSavedSpriteAsset, getSpriteAsset } from "../core";
import { spritesHead } from "./internal/head";
import { runtimeSymbolsServed } from "./internal/runtime-symbols-value";
import {
  handleSpriteAsset,
  iconSpriteServed,
  spriteHashServed,
} from "./internal/sprite-value";
import {
  handleSavedSpriteAsset,
  savedSymbolsHashServed,
} from "./internal/saved";

export {
  drawRuntimeSymbol,
  RUNTIME_SYMBOL_BUILD_VERSION,
  RuntimeSymbolDrawer,
} from "./internal/drawer";
export type { RuntimeSymbolDrawerImpl } from "./internal/drawer";
export { savedIconNames } from "./internal/saved";
export { SpriteDrawer } from "./internal/sprite-drawer";
export type { DrawnSprite, SpriteDrawerImpl } from "./internal/sprite-drawer";
export { buildSprite } from "./internal/build-sprite";
export { buildLucideSprites, buildSetiSprite } from "./internal/family-sprites";
export { LUCIDE_TUNING_VERSION } from "./internal/lucide";

export default {
  description:
    "The build's sprites, on every host, drawn through the host's SpriteDrawer — the computer's installed sets (this plugin's machine half) or the Seti and Lucide sets bundled with a browser host (plugins/bundled-sprites): icons.sprite (one sprite by key on demand, immutable, content-addressed by icons.sprite-hash, preloaded) and GET /api/icons/sprite-assets/:hash/:key, the same sprite as an asset the browser caches for good. Saved (user-picked) icons as runtime symbols, drawn through the host's RuntimeSymbolDrawer (the installed sets, or a set bundled with the page — plugins/bundled-symbols): icons.runtime-symbols serves any saved names in any style on demand (immutable, content-addressed by icons.symbols-hash, preloaded), and GET /api/icons/saved-sprite-assets/:hash the default styles' drawing of every name a saved-icon source (ui/icons/saved-sources) reports, revalidated by an ETag over the names. A DocumentHead.Fragment starts both asset requests in the SPA shell's head, so the sprites a first paint needs never ride the boot snapshot.",
  httpRoutes: {
    [getSpriteAsset.route]: handleSpriteAsset,
    [getSavedSpriteAsset.route]: handleSavedSpriteAsset,
  },
  contributions: [
    spritesHead,
    ...savedSymbolsHashServed.declare,
    ...runtimeSymbolsServed.declare,
    ...iconSpriteServed.declare,
    ...spriteHashServed.declare,
  ],
} satisfies ServerPluginDefinition;
