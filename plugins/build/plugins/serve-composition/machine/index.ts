import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { serveStatusServed } from "./internal/serve-status-value";

export default {
  description:
    "Serve liveness, desktop-only: the build.serve-status live value — where this backend's checkout serves a composition and whether its composition.json marker is there, notified by a watch on the marker.",
  contributions: [...serveStatusServed.declare],
} satisfies MachinePluginDefinition;
