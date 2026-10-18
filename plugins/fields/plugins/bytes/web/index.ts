import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { bytesIdentity } from "../core";

export default {
  description:
    "Bytes field type: identity only — binary data whose wire value is base64. No cell or filter: no list shows a blob.",
  contributions: [Fields.Identity({ identity: bytesIdentity })],
} satisfies PluginDefinition;
