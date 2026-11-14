import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getGlyphAsset, getSpriteAsset } from "../core";
import { handleGlyphAsset } from "./internal/glyph-asset";
import { spritesHead } from "./internal/head";
import { runtimeSymbolsServed } from "./internal/runtime-symbols-value";
import {
  handleSpriteAsset,
  iconSpriteServed,
  spriteHashServed,
} from "./internal/sprite-value";
import { savedSymbolsHashServed } from "./internal/saved";

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
    "The build's icons, on every host, loaded glyph by glyph — a page downloads what it draws. icons.runtime-symbols serves any Material name in any style (code symbols and saved icons alike, drawn through the host's RuntimeSymbolDrawer: the computer's installed sets, or plugins/bundled-symbols on a browser host) and any Lucide glyph (picked from the host's SpriteDrawer: the installed sets, or plugins/bundled-sprites), batched per frame, immutable, content-addressed by the key's own hash (icons.symbols-hash for Material — never the code's manifest — icons.sprite-hash for Lucide); GET /api/icons/glyph-assets/:hash/:key/:names is the same batch as an asset the browser caches for good. Whole sprites remain for the six brand marks (resident) and the Seti file-type set (on demand): icons.sprite and GET /api/icons/sprite-assets/:hash/:key. A DocumentHead.Fragment starts, in the SPA shell's head, the brands and the glyph batches the page's last first frame drew (remembered in localStorage), so a warm first frame wants nothing and nothing rides the boot snapshot.",
  httpRoutes: {
    [getSpriteAsset.route]: handleSpriteAsset,
    [getGlyphAsset.route]: handleGlyphAsset,
  },
  contributions: [
    spritesHead,
    ...savedSymbolsHashServed.declare,
    ...runtimeSymbolsServed.declare,
    ...iconSpriteServed.declare,
    ...spriteHashServed.declare,
  ],
} satisfies ServerPluginDefinition;
