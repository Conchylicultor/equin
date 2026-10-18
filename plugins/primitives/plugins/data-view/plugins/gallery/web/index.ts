import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { GalleryView } from "./components/gallery-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { DataCard } from "./components/data-card";
export type { DataCardProps } from "./components/data-card";
export type { CoverContent, GalleryViewOptions } from "../core";

export default {
  description:
    "Gallery view child for the data-view primitive: a responsive card grid with a field-driven default card plus a composable DataCard chrome.",
  contributions: [
    DataViewSlots.View({
      type: "gallery",
      companion: true,
      title: "Gallery",
      icon: symbol("grid-view"),
      order: 0,
      loadingVariant: "cards",
      loadingCount: 8,
      // Per-instance options sub-form (ST4 demonstrator): a named gallery
      // instance can pick which field id supplies the card cover. The gallery
      // already reads `options.coverField`, so this round-trips end-to-end.
      configSchema: {
        coverField: textField({
          label: "Cover field",
          description: "Field id whose value supplies the card cover image.",
        }),
      },
      component: GalleryView,
    }),
  ],
} satisfies PluginDefinition;
