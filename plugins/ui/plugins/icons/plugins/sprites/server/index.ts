import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runtimeSymbolsServed } from "./internal/runtime-symbols-value";
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

export default {
  description:
    "Saved (user-picked) icons as runtime symbols, on every host: the resident icons.saved-sprites value draws every name a saved-icon source (ui/icons/saved-sources) reports in the default style, and the on-demand icons.runtime-symbols value serves any saved names in any style, immutable (content-addressed by symbolsHash). Both draw through the host's RuntimeSymbolDrawer — the icon sets installed on the computer (this plugin's machine half), or a set bundled with the page (plugins/bundled-symbols, a browser host) — so a demo's icons come from its own server.",
  contributions: [
    ...savedIconsChangedServed.declare,
    ...savedIconSpritesServed.declare,
    ...runtimeSymbolsServed.declare,
  ],
} satisfies ServerPluginDefinition;
