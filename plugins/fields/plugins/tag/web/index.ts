import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { tagIdentity } from "../core";

export default {
  description:
    "Tag field type: identity only, extends enum — one value out of an option forest, reusing enum's cell, filter and inline editor via the extends chain. Its nested grouping lives in the plugins/data-view-group sub-plugin.",
  contributions: [Fields.Identity({ identity: tagIdentity })],
} satisfies PluginDefinition;
