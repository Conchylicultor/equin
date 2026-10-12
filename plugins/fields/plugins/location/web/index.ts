import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { locationIdentity } from "../core";

export default {
  description:
    "Location field type: identity only. The read cell lives in the plugins/table sub-plugin, the is-set filter in plugins/filter, the jsonb column in plugins/storage.",
  contributions: [Fields.Identity({ identity: locationIdentity })],
} satisfies PluginDefinition;
