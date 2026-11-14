import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { posterHead } from "./internal/poster-head";

export default {
  description:
    "The landing page's head (DocumentHead.Fragment): preloads the showcase film's poster — the page's largest paint — from t0, on the landing page only, instead of once the hero has rendered.",
  contributions: [posterHead],
} satisfies ServerPluginDefinition;
