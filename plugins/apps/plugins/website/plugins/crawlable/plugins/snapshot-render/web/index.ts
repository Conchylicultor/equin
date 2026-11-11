import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { renderSiteSnapshot } from "./internal/render-snapshot";

export default {
  description:
    "The crawlable snapshot's render half, build-only: renderSiteSnapshot renders each declared website page once by its path through the real app (static-render over the composition's plugins and a boot snapshot), filters it to semantic HTML, titles it as the live app titles its tab, and returns the snapshot manifest (with the composition's home) and fragments — loaded by the snapshot take in Bun by path, and in no composition (base-exclusions), so no browser registry holds it.",
  contributions: [],
} satisfies PluginDefinition;
