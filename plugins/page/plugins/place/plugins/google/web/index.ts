import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  MapsAccessAction,
  useMapsAccess,
} from "@plugins/integrations/plugins/google-maps/web";
import { Place } from "@plugins/page/plugins/place/web";
import { GOOGLE_PLACE_PROVIDER_ID } from "../core";
import { brand } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Google Maps as a place-lookup source for the /place block: contributes the provider's name, icon, and the 'set up Google Maps' affordance the block renders while no API key is configured.",
  contributions: [
    Place.Provider({
      id: GOOGLE_PLACE_PROVIDER_ID,
      label: "Google Maps",
      icon: brand("googlemaps"),
      // Rendered in place of the search box while no key is configured. The
      // block never learns that the blocker is a key — it just renders whatever
      // the provider says will fix it.
      AccessAction: MapsAccessAction,
      useReady: () => useMapsAccess("places").ready,
    }),
  ],
} satisfies PluginDefinition;
