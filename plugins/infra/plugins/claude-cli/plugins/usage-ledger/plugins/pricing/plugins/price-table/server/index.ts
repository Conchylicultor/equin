import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { priceTableRefreshJob, priceVersionWarmup } from "./internal/refresh";
import { unpricedModelKind } from "./internal/unpriced";

export {
  fetchPriceTable,
  loadPriceTable,
  mergePriceTable,
  parseLiteLlmTable,
  savePriceTable,
} from "./internal/price-table";
export { loadFallbackPriceTable } from "./internal/litellm-fallback";

export default {
  description:
    "The Claude price table as a file and a fetch, and what keeps the dated price history current: our merge-only copy of LiteLLM's model_prices_and_context_window.json (parseLiteLlmTable — the Anthropic-relevant slice; mergePriceTable — never drops a key) persisted in the host's cost-usage data dir (loadPriceTable / savePriceTable, the vendored litellm-fallback.json floor), the daily claude-cli.pricing.refresh job on main (fetch, merge, save, record a new price version when a rate moved, file cost-unpriced-model for every model the priced view leaves unpriced) and the boot warm-up recording the held table as the first version. Not portable (file persistence); the price history itself (versions, rates, the priced view) is its portable parent's.",
  contributions: [unpricedModelKind],
  register: [priceTableRefreshJob, priceVersionWarmup],
} satisfies ServerPluginDefinition;
