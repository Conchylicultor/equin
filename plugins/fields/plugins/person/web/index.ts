import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { personIdentity } from "../core";

export default {
  description:
    "Person field type (a person's display name, free text): extends text — text's sort, filter and editor via the extends chain, its own initial-avatar + name cell.",
  contributions: [Fields.Identity({ identity: personIdentity })],
} satisfies PluginDefinition;
