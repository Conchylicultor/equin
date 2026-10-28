import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { moneyIdentity } from "../core";

export default {
  description:
    "Money field type: identity only, extends float — an amount in US dollars, drawn as currency (`$42.17`); sort, filter and grouping inherited from float → number.",
  contributions: [Fields.Identity({ identity: moneyIdentity })],
} satisfies PluginDefinition;
