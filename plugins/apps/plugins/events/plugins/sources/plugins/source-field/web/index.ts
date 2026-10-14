import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { sourceIdPresentation } from "./internal/presentation";

export default {
  description:
    "Presents the events entity's `sourceId` field with the live configured sources as its options, so every list of events filters, sorts and groups by source with no edit to event-list.",
  contributions: [sourceIdPresentation],
} satisfies PluginDefinition;
