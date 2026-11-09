import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { prestartHead } from "./internal/prestart-head";

export default {
  description:
    "The /demo page's head script (DocumentHead.Fragment): starts the demo's browser host before the app boots, so its worker boots alongside the page's own bundle.",
  contributions: [prestartHead],
} satisfies ServerPluginDefinition;
