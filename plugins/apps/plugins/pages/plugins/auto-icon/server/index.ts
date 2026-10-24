import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { pageBlocksAutoIcon } from "./internal/tables";

export default {
  portable: true,
  description:
    "Auto-icon provenance (page_blocks_ext_auto_icon): a row records that icon generation ran for a page, so it never runs again unasked. Everything model-driven — the pick, its jobs, the boot backfill and Regenerate — is the machine half's.",
} satisfies ServerPluginDefinition;
