import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { RuntimeSymbolDrawer, SpriteDrawer } from "../server";
import { iconManifestServed } from "./internal/manifest";
import { installedSetsDrawer } from "./internal/runtime-symbols";
import { installedSetsSpriteDrawer } from "./internal/sprites";

export { manifestSymbolBody } from "./internal/sprites";

export default {
  description:
    "Builds the icon sprites from the Iconify JSON for the manifest's names — one <svg> of <symbol id=\"ms-<styleKey>-<name>\"> per style key (material-symbols at 400, material-symbols-light at 300) plus a brands sprite — and provides the SpriteDrawer every one is read through (icons.sprite and the sprite assets, this plugin's portable half). icons.manifest serves the manifest's symbol names (Debug → Icons' rows). Desktop-only (needsMachine): the sprites are built from the icon sets installed on the computer. Provides the RuntimeSymbolDrawer the saved-icon values (this plugin's portable server half) draw through: both installed Material Symbols sets, every style. manifestSymbolBody(name) is a manifest symbol's default-style glyph as a bare body, from the same one-pass build (an app's OS icon: no second parse of the sets).",
  contributions: [
    SpriteDrawer.provide(installedSetsSpriteDrawer),
    ...iconManifestServed.declare,
    RuntimeSymbolDrawer.provide(installedSetsDrawer),
  ],
} satisfies MachinePluginDefinition;
