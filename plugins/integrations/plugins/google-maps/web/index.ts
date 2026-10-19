import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { LiveMapSetup } from "./slots";
import { Auth } from "@plugins/auth/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useLiveMapStatus } from "./internal/use-live-map-status";
import { LIVE_MAP_ACCOUNT_ID } from "./internal/live-map-account";
import { LiveMapSetupBody } from "./components/live-map-setup";

export {
  useMapsAccess,
  type MapsAccess,
  type MapsAccessBlocker,
  type MapsAccessCapability,
} from "./internal/use-maps-access";
export {
  useMapsBrowserConfig,
  type MapsBrowserConfigState,
} from "./internal/use-maps-browser-config";
export {
  MapsAccessAction,
  MAPS_BLOCKER_BODY,
} from "./components/maps-access-action";
export { MapsMapAccessAction } from "./components/maps-map-access-action";
export { MapIdRasterNotice } from "./components/map-id-raster-notice";
export {
  LiveMapSetup,
  type MapRendering,
  type MapIdPreviewProps,
  type MapIdPreviewResult,
} from "./slots";

export default {
  description:
    "Google Maps Platform access broker (web): per-capability readiness (Places lookups vs the live map), the public browser config read, the 'set up Google Maps' / 'set up the live map' affordances consumers render in place of routing the user to Settings, and the Live map setup — the Google Maps 'Live map' row of Settings → Accounts, rendered inline in its account pane — (browser key, plus the optional vector-map Map ID, checked live by a preview map the renderer plugin draws into the setup's LiveMapSetup.MapIdPreview slot).",
  contributions: [
    Auth.Integration({
      id: LIVE_MAP_ACCOUNT_ID,
      name: "Live map",
      icon: symbol("map"),
      service: "Google Maps",
      description: "Browser key for the interactive map.",
      setup: LiveMapSetupBody,
      useStatus: useLiveMapStatus,
    }),
  ],
  slots: {
    liveMapSetup: LiveMapSetup,
  },
} satisfies PluginDefinition;
