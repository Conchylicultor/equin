import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { prototypesIcons } from "../core";

export default {
  description:
    "Contributes the prototypes icon family (prototypesIcons) to Icons.Family, so a scope whose iconFamily is prototypes — the Prototypes theme's — draws its glyphs.",
  contributions: [Icons.Family({ family: prototypesIcons })],
} satisfies PluginDefinition;
