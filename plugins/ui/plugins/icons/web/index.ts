import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { LUCIDE_FAMILY } from "../core";
import { Icons } from "./slots";
import { IconFamilyHost } from "./internal/family-host";

export { Icon, useIconStyle } from "./internal/icon";
export type { IconProps } from "./internal/icon";
export { IconFamilyPreview, IconScopeProvider } from "./internal/icon-scope";
export {
  usePublishIconStyle,
  useScopeIconStyles,
  useWantedStyleKeys,
} from "./internal/style-store";
export { provideSprite, useWantedSprites } from "./internal/sprite-store";
export { IconSpriteSheet } from "./internal/sprite-sheet";
export { Icons } from "./slots";
export type { IconFamilyContribution } from "./slots";
export { useIconFamilies } from "./internal/family-store";
export { resolveIconSource } from "./internal/icon-drawing";
export type { IconSource } from "./internal/icon-drawing";
export { IconMotionRegion } from "./internal/motion-region";
export { iconFamilyGapReportSink } from "./internal/family-gap";
export type { IconFamilyGap } from "./internal/family-gap";
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
    "Draws icons: <Icon icon={symbol(…)} active?/> renders an IconRef from the page's inline SVG sprites in its theme scope's icon style. A leaf below the ui-kit — it knows no theme: the icons token group publishes each scope's style (usePublishIconStyle), <Theme> boundaries say which scope an icon is in (IconScopeProvider), and the sprites plugin fills and mounts the sheet. Icon families beyond Material are contributed to Icons.Family (Lucide is this plugin's own; an app draws its own with defineIconFamily), published to <Icon> by IconFamilyHost. A family states its coverage: fallback (an unmapped symbol draws the next family of its chain, Material last) or strict (its gap glyph, reported through iconFamilyGapReportSink); resolveIconSource answers which, by the same chain. Animated family glyphs (data-motion parts, a closed ICON_MOTIONS vocabulary) are drawn inline and play once on hover inside an IconMotionRegion.",
  contributions: [
    Core.Root({ slot: Icons.Root }),
    Icons.Root({ component: IconFamilyHost, companion: true }),
    Icons.Family({ family: LUCIDE_FAMILY }),
  ],
  slots: Icons,
} satisfies PluginDefinition;
