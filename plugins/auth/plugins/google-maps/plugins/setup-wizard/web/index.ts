import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { GOOGLE_MAPS_PROVIDER_ID } from "@plugins/auth/plugins/google-maps/core";
import { GoogleMapsSetup } from "./components/google-maps-setup";
import { brand } from "@plugins/ui/plugins/icons/core";

// The Accounts row lives here rather than on the parent plugin (which google's
// OAuth provider does) because the row's `setup` is this plugin's component
// and the component needs `GOOGLE_MAPS_PROVIDER_ID`: parent → wizard → parent
// is a cross-plugin cycle the boundary check rejects. `auth/apple-signing` is
// the existing precedent for a wizard sub-plugin owning its row.
export default {
  description:
    "Guided setup steps for the Google Maps Platform API key (project → Places API → billing → key → paste), rendered inline in its Accounts pane; contributes the Accounts provider row.",
  contributions: [
    Auth.Provider({
      id: GOOGLE_MAPS_PROVIDER_ID,
      name: "Places API key",
      service: "Google Maps",
      description: "Server-side key for place search and details.",
      icon: brand("googlemaps"),
      setup: { kind: "steps", component: GoogleMapsSetup },
    }),
  ],
} satisfies PluginDefinition;
