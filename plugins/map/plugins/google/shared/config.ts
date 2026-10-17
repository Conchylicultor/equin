import { defineConfig } from "@plugins/config_v2/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";

export const googleMapConfig = defineConfig({
  fields: {
    scrollZoomSpeed: floatField({
      default: 1,
      min: 0.25,
      max: 4,
      step: 0.25,
      label: "Scroll zoom speed",
      description:
        "How far one scroll of the mouse wheel or trackpad zooms the smooth (vector) map: 1 is the default, 0.5 half as far, 2 twice as far. A trackpad pinch always follows the fingers.",
    }),
  },
});
