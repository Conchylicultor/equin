import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { usePlaceDetails } from "./internal/hooks";

export default {
  description:
    "Reads Google's rich details of a saved place (usePlaceDetails) for the place card.",
  contributions: [],
} satisfies PluginDefinition;
