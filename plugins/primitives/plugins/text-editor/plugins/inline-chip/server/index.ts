import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  expandInlineTokenReferents,
  followedReferent,
  inlineTokenReferentFollows,
  inlineTokensAsLiveText,
  InlineTokenReferentSource,
} from "./internal/referents";
export type {
  FollowedReferent,
  InlineTokenLiveRead,
  InlineTokenReferent,
} from "./internal/referents";

export default {
  description:
    "Server-side referents of inline tokens: chip families contribute InlineTokenReferentSource (their chip's pattern, a resolve to the referent's title, and how a live value reads it — followed by id through a served lookup, untracked for a file, or not-in-text for a transcript-only chip), and expandInlineTokenReferents rewrites a text's tokens as `<kind id title/>` so a model reads what the chip shows instead of an opaque id; inlineTokensAsLiveText replaces them with the bare title inside a live value, reading only the referent rows its inlineTokenReferentFollows followed.",
} satisfies ServerPluginDefinition;
