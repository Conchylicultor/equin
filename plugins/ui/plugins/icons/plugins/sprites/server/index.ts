import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runtimeSymbolsServed } from "./internal/runtime-symbols-value";
import { iconSpriteServed, spriteHashServed } from "./internal/sprite-value";
import {
  savedIconSpritesServed,
  savedIconsChangedServed,
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
    "The build's sprites on demand, on every host: icons.sprite (one sprite by key, immutable, content-addressed by icons.sprite-hash) drawn through the host's SpriteDrawer — the computer's installed sets (this plugin's machine half) or the Seti and Lucide sets bundled with a browser host (plugins/bundled-sprites) — so a scope reads its sprites from its own server. Saved (user-picked) icons as runtime symbols, on every host: the resident icons.saved-sprites value draws every name a saved-icon source (ui/icons/saved-sources) reports in the default style, and the on-demand icons.runtime-symbols value serves any saved names in any style, immutable (content-addressed by symbolsHash). Both draw through the host's RuntimeSymbolDrawer — the icon sets installed on the computer (this plugin's machine half), or a set bundled with the page (plugins/bundled-symbols, a browser host) — so a demo's icons come from its own server.",
  contributions: [
    ...savedIconsChangedServed.declare,
    ...savedIconSpritesServed.declare,
    ...runtimeSymbolsServed.declare,
    ...iconSpriteServed.declare,
    ...spriteHashServed.declare,
  ],
} satisfies ServerPluginDefinition;
