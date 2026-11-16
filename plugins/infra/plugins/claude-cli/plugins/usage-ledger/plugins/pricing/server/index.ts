import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { View } from "@plugins/database/plugins/derived-views/server";
import { IdKinds } from "@plugins/ids/server";
import { priceVersionIdKind } from "../core";
import { claudeSpendHoursView } from "./internal/views";

export { _claudeModelRates, _claudePriceVersions } from "./internal/tables";
export { claudeSpendHoursView } from "./internal/views";
export {
  ensureModelRates,
  recordPriceVersion,
  type RecordedPriceVersion,
} from "./internal/versions";

export default {
  description:
    "Claude pricing as dated data: claude_price_versions (each table in force from effective_from — the first from -infinity, a refresh that changes a rate from now, a correction from a past instant) with claude_model_rates (per version, observed model and speed, materialized per-token rates below/above the 200k tier, resolved once with resolveModel), and the claude_spend_hours_v view — every usage-ledger hour priced with the newest version in force at that hour, cost_usd NULL (never 0) when unpriced.",
  contributions: [
    View({ view: claudeSpendHoursView }),
    IdKinds.Kind({ kind: priceVersionIdKind }),
  ],
} satisfies ServerPluginDefinition;
