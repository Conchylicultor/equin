import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  reclaimCompositionNamespaces,
  resetCompositionData,
  serveStatusEndpoint,
} from "../shared/endpoints";
import { handleReclaim } from "./internal/handle-reclaim";
import { handleReset } from "./internal/handle-reset";
import { handleServeStatus } from "./internal/handle-status";

// The reset itself, for a `./equin` verb acting on this checkout (it passes
// the checkout's namespace, having no runtime one): the same four guards and
// recipe the Reset button's endpoint runs.
export { resetServedComposition } from "./internal/reset-served-composition";

export default {
  description:
    "Serve-liveness read for a composition: WHERE this backend's checkout serves it (the server-resolved namespace + url) and whether anything is actually there (the composition.json marker), plus the reset-to-first-launch endpoint — wipes ONLY that namespace's DB + config back to what a serve build provisions on a fresh serve, then restarts its backend. Never touches the checkout's own app. Also reclaims everything a composition owns across EVERY checkout that has served it (the set the machine half's build.serve-owned value names), per-namespace outcomes reported individually.",
  httpRoutes: {
    [resetCompositionData.route]: handleReset,
    [serveStatusEndpoint.route]: handleServeStatus,
    [reclaimCompositionNamespaces.route]: handleReclaim,
  },
} satisfies ServerPluginDefinition;
