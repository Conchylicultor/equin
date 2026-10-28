import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { identifierIdentity } from "../core";

export default {
  description:
    "Identifier field type (a sha, run id, fingerprint, slug, tool name): extends text — text's sort, filter and editor via the extends chain, its own monospace cell.",
  contributions: [Fields.Identity({ identity: identifierIdentity })],
} satisfies PluginDefinition;
