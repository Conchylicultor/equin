import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { ordinalIdentity } from "../core";

export default {
  description:
    "Ordinal field type: identity only, extends int — a position, rank or version number, drawn faint and tabular with no thousands grouping; sort, filter and grouping inherited from int → number.",
  contributions: [Fields.Identity({ identity: ordinalIdentity })],
} satisfies PluginDefinition;
