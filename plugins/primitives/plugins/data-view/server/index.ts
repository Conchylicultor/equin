import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { dataViewConfigRegistrations } from "./internal/config-registrations";
import { filterNodeIdKind, presetIdKind } from "../core";
// Registers the view-icons saved-icon source (module eval).
import "./internal/saved-icons";

export {
  readDataViewConfigDoc,
  watchDataViewConfigDoc,
} from "./internal/descriptors";

export default {
  description:
    "Notion-like multi-view data surface: one typed field schema rendered through swappable views with per-view sort/search/filter.",
  // One config_v2 `views` descriptor per DataView id, registered under the
  // `primitives.data-view` plugin (server-side identity, independent of web).
  contributions: [
    IdKinds.Kind({ kind: presetIdKind }),
    IdKinds.Kind({ kind: filterNodeIdKind }),
    ...dataViewConfigRegistrations,
  ],
} satisfies ServerPluginDefinition;
