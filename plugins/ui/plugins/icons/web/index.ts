import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "./slots";

export { Icon, useIconStyle } from "./internal/icon";
export type { IconProps } from "./internal/icon";
export { IconScopeProvider } from "./internal/icon-scope";
export {
  usePublishIconStyle,
  useWantedStyleKeys,
} from "./internal/style-store";
export {
  hasSprite,
  provideSprite,
  useWantedSprites,
} from "./internal/sprite-store";
export { IconSpriteSheet } from "./internal/sprite-sheet";
export { Icons } from "./slots";
export { useIconMarkup } from "./internal/icon-markup";
export type { IconMarkup, IconMarkupReader } from "./internal/icon-markup";
export {
  hasRuntimeSymbol,
  installRuntimeSymbolLoader,
  provideRuntimeSymbols,
} from "./internal/runtime-symbol-store";
export type { RuntimeSymbolEntry } from "./internal/runtime-symbol-store";

export default {
  description:
    "Draws icons: <Icon icon={symbol(…)} active?/> renders an IconRef from the page's inline SVG sprites in its theme scope's icon style. A leaf below the ui-kit — it knows no theme: the icons token group publishes each scope's style (usePublishIconStyle), <Theme> boundaries say which scope an icon is in (IconScopeProvider), and the sprites plugin fills and mounts the sheet.",
  contributions: [Core.Root({ slot: Icons.Root })],
  slots: Icons,
} satisfies PluginDefinition;
