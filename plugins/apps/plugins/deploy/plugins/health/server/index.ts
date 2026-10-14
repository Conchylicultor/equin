import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { serverHealthRowsServed } from "./internal/resource";
import { serverHealth } from "./internal/tables";
import { handleCheckSsh } from "./internal/handle-check";
import { handleForgetHostKey } from "./internal/handle-forget-host-key";
import { checkServerSsh, forgetServerHostKey } from "../shared/endpoints";

export { serverHealth } from "./internal/tables";
export { resolveServerSshTarget } from "./internal/ssh-target";
export type {
  DeployServerRow,
  HostKeyPolicy,
  ServerSshTargetResult,
} from "./internal/ssh-target";
export { ServerHealthRowSchema } from "../shared";
export type { ServerHealthRow } from "../shared";

export default {
  description:
    "Owns the deploy_servers_ext_health side-table: the last SSH reachability verdict per server (ok, classified failure kind, the public key as of the check, and the TOFU-pinned host key), its live collection, its `status` field exposed to every list of servers, and the probe / forget-host-key endpoints.",
  contributions: [
    ...serverHealthRowsServed.declare,
    // The verdict (`ok`, as `status`) folded into every list of servers.
    LiveColumns.Expose(serverHealth),
  ],
  httpRoutes: {
    [checkServerSsh.route]: handleCheckSsh,
    [forgetServerHostKey.route]: handleForgetHostKey,
  },
} satisfies ServerPluginDefinition;
