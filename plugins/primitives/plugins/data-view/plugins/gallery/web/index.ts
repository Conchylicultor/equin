import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { GalleryView } from "./components/gallery-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { DataCard } from "./components/data-card";
export type { DataCardActions, DataCardProps } from "./components/data-card";

export default {
  description:
    "Gallery view child for the data-view primitive: a responsive grid of cover cards — the cover is the card, its fields three fixed lines under it, its actions on the cover.",
  contributions: [
    DataViewSlots.View({
      type: "gallery",
      companion: true,
      title: "Gallery",
      icon: symbol("grid-view"),
      order: 0,
      loadingVariant: "cards",
      loadingCount: 8,
      component: GalleryView,
    }),
  ],
} satisfies PluginDefinition;
