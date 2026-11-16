import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { priceVersionIdKind } from "../core";

export default {
  description:
    "Claude pricing, web half: registers the price version id kind (pricev), so its ids are recognised in the browser as on the server.",
  contributions: [IdKinds.Kind({ kind: priceVersionIdKind })],
} satisfies PluginDefinition;
