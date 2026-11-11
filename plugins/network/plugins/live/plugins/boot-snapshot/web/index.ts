import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { bootSnapshotTask } from "./internal/boot";

export { hydrateBootSnapshot } from "./internal/hydrate";
export type {
  BootSnapshotHydration,
  BootSnapshotValues,
} from "./internal/hydrate";

export default {
  description:
    "Hydrates all boot-critical resources from a single boot snapshot before first paint.",
  contributions: [bootSnapshotTask],
} satisfies PluginDefinition;
