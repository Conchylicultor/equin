import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { IntegrationStatus } from "@plugins/auth/web";
import { mapsBrowserConfig } from "@plugins/integrations/plugins/google-maps/plugins/browser-config/core";

/** The live map's Accounts row status: whether a browser key is stored, and which map it draws. */
export function useLiveMapStatus(): ResourceResult<IntegrationStatus> {
  return mapResource(useLive(mapsBrowserConfig), (config) =>
    config.kind === "set"
      ? {
          tone: "success",
          label: "Set up",
          summary: config.mapId ? "Vector map" : "Raster map",
        }
      : config.kind === "pending"
        ? // A browser host whose page has not handed its key over yet — not
          // "Not set up", which would be a claim about a key nobody knows yet.
          {
            tone: "muted",
            label: "Waiting for the page",
            summary: "The page has not handed its map key over yet",
          }
        : { tone: "muted", label: "Not set up" },
  );
}
