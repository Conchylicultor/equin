import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { IntegrationStatus } from "@plugins/auth/web";
import { mapsBrowserConfig } from "../../core";

/** The live map's Accounts row status: whether a browser key is stored, and which map it draws. */
export function useLiveMapStatus(): ResourceResult<IntegrationStatus> {
  return mapResource(useLive(mapsBrowserConfig), (config) =>
    config.kind === "set"
      ? {
          tone: "success",
          label: "Set up",
          summary: config.mapId ? "Vector map" : "Raster map",
        }
      : { tone: "muted", label: "Not set up" },
  );
}
