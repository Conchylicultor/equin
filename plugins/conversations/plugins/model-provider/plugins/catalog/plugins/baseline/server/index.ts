import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { BASELINE_MODELS } from "@plugins/conversations/plugins/model-provider/core";
import { ModelCatalogSource } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";

export default {
  description:
    "The model catalog of a host without the computer: provides ModelCatalogSource as the code baseline (BASELINE_MODELS) — the catalog of a machine that never probed its Claude CLI, since there is no CLI to discover from (the browser composition). Never booted by the desktop.",
  portable: true,
  contributions: [ModelCatalogSource.provide({ read: () => BASELINE_MODELS })],
} satisfies ServerPluginDefinition;
