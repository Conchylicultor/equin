import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { getPlacesClient, type PlacesClientResult } from "./internal/key";

export default {
  description:
    "Google Maps Platform access broker, desktop half: getPlacesClient() hands out the metered Places client (the stored Places API key, read via the shared auth/central store, plus the usage ledger's meter), so consumers never import @plugins/auth and no Places call goes uncounted.",
} satisfies MachinePluginDefinition;
