import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Glass } from "./internal/glass";
export type { GlassProps, GlassShape, GlassTint } from "./internal/glass";

export default {
  description:
    "The player's one floating surface: <Glass> — a barely translucent, blurred panel with a top sheen and a hairline edge that the toolbar pill, the progression capsule and the section rail all float on over the notes (menus stay the theme's solid popover). A shape (pill / panel) and a tint (the bars' or the progression capsule's deeper glass).",
  contributions: [],
} satisfies PluginDefinition;
