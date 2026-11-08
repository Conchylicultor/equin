import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { SpriteDrawer } from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { bundledSpriteDrawer } from "./internal/drawer";

export default {
  description:
    "The on-demand sprites of a host without the computer's icon sets (the browser composition): provides the SpriteDrawer from the sets bundled with the worker — the vendored Seti file-type set (every glyph) and the Lucide set (every name LUCIDE_MAP draws), each loaded lazily on its first read — so a scope's file-type and Lucide icons come from its own server. The Material styles and the brands are the page's resident sprites: a read of one is refused not-drawn-here. Never booted by the desktop.",
  contributions: [SpriteDrawer.provide(bundledSpriteDrawer)],
} satisfies ServerPluginDefinition;
