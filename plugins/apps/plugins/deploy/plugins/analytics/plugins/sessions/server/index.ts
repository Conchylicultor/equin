import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deploymentSessionsServed } from "./internal/served";

export default {
  description:
    "Reads a deployment's visits over SSH through host-query's hostOnlyQueryOverSsh (collect's host-only sessions query, curled through the install's own gateway), one key range per page, and their per-shape counts — or which of SSH, the request or the answer failed.",
  contributions: [...deploymentSessionsServed.declare],
} satisfies ServerPluginDefinition;
