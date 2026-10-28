import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { byteSizeIdentity } from "../core";

export default {
  description:
    "Byte-size field type: identity only, extends number — a size in bytes, drawn in SI units (`840 B`, `18.4 kB`, `1.5 GB`) and filtered by operands typed in units (`1 GB`, `500kB`); sort and grouping inherited from number. (`bytes` is the binary-data type.)",
  contributions: [Fields.Identity({ identity: byteSizeIdentity })],
} satisfies PluginDefinition;
