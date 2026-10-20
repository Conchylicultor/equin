import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { sonataIcons } from "../core";

export default {
  description:
    "Contributes the sonata icon family (sonataIcons) to Icons.Family, so a scope whose iconFamily is sonata — the Sonata theme's — draws its glyphs.",
  contributions: [Icons.Family({ family: sonataIcons })],
} satisfies PluginDefinition;
