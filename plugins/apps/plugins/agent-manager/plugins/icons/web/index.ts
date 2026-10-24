import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { agentIcons } from "../core";

export default {
  description:
    "Contributes the agent icon family (agentIcons) to Icons.Family, so a scope whose iconFamily is agent — the Mist theme's — draws its glyphs.",
  contributions: [Icons.Family({ family: agentIcons })],
} satisfies PluginDefinition;
