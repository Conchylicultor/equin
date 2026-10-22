import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  expandInlineTokenReferents,
  inlineTokenReferentTables,
  inlineTokensAsText,
  InlineTokenReferentSource,
} from "./internal/referents";
export type { InlineTokenReferent } from "./internal/referents";

export default {
  portable: true,
  description:
    "Server-side referents of inline tokens: chip families contribute InlineTokenReferentSource (their chip's pattern + a resolve to the referent's title), and expandInlineTokenReferents rewrites a text's tokens as `<kind id title/>` so a model reads what the chip shows instead of an opaque id; inlineTokensAsText replaces them with the bare title, for text a person reads.",
} satisfies ServerPluginDefinition;
