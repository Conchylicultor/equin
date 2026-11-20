import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { CatNListing } from "./components/code-listing";

export default {
  description:
    "Renders `cat -n` tool output (`CatNListing`) as a syntax-highlighted, line-numbered listing: parses the gutter off and hands the code to syntax-highlight's `CodeListing`.",
  contributions: [],
} satisfies PluginDefinition;
