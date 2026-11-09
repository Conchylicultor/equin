import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { TokenPastePlugin } from "./components/token-paste-plugin";
export { TokenBoundaryPlugin } from "./components/token-boundary-plugin";
export { TokenFrame } from "./components/token-frame";

export default {
  description:
    "The inline-token node factory's browser half: TokenPastePlugin, the registry-driven paste that materializes a pasted token as its node and declines an intra-app copy (which already carries the materialized nodes); TokenBoundaryPlugin, which puts a space between a token and whatever beside it would fuse with it once serialized (two id chips, a letter typed against a chip), so saved text reads back as the same tokens; and TokenFrame, the editing chrome every decorated token wears in an editable editor (selected as one object with a ring, never its characters; a hover-revealed × removes it).",
  contributions: [],
} satisfies PluginDefinition;
