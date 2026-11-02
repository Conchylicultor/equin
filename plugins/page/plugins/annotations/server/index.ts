import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { humanAudienceTypes } from "./internal/audience";

export default {
  description:
    "The annotation family's server-side reading of its audience axis: humanAudienceTypes(), the block types withheld from agents, read off the Editor.BlockData registry at call time.",
} satisfies ServerPluginDefinition;
