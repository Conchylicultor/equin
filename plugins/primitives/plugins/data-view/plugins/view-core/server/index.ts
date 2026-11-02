import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { viewIdKind } from "../core";

export { viewsDescriptor } from "../shared";
export { buildViewConfigRegistrations } from "./internal/config-registrations";

export default {
  description:
    "Type-agnostic named-view-instance engine (server): the per-id `views` config descriptor + a generic registration helper. Consumers register their own ids under their own plugin.",
  // Headless engine — registers only the view-instance id kind (`view-…`).
  // Consumers register their own per-id `ConfigV2.Register` via `buildViewConfigRegistrations`.
  contributions: [IdKinds.Kind({ kind: viewIdKind })],
} satisfies ServerPluginDefinition;
