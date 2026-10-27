import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { serveOwnedServed } from "./internal/serve-owned-value";
import { serveStatusServed } from "./internal/serve-status-value";

export default {
  description:
    "Serve liveness, desktop-only: the build.serve-status live value — where this backend's checkout serves a composition and whether its composition.json marker is there, notified by a watch on the marker; and the build.serve-owned snapshot — every namespace a composition occupies across all checkouts (the marker scan behind the delete confirmation).",
  contributions: [...serveStatusServed.declare, ...serveOwnedServed.declare],
} satisfies MachinePluginDefinition;
