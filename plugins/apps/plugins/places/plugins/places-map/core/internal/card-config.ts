import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

/**
 * What the place cards of the side panel (its gallery and list) show beyond
 * the place itself.
 */
export const placeCardsConfig = defineConfig({
  name: "place-cards",
  fields: {
    showOpeningHours: boolField({
      label: "Opening hours on the cards",
      description:
        "Today's opening hours of each place — Google's own, read when the card is drawn — on its card in the side panel.",
      default: false,
    }),
  },
});
