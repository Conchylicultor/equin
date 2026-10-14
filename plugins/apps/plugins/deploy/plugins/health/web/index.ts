import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ServerDetail } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { serverStatusPresentation } from "./internal/status-presentation";
import {
  ServerStatusSection,
  ServerStatusSummary,
} from "./components/status-section";

export {
  useServerHealthMap,
  useServerHealth,
  useServerVerified,
} from "./hooks";
export { VerifyConnectionBody } from "./components/verify-connection";
export {
  ServerStatusBadge,
  serverStatus,
} from "./components/server-status-badge";
export type { ServerStatus } from "./components/server-status-badge";
export { checkServerSsh, forgetServerHostKey } from "../shared";
export type { ServerHealthRow, SshCheckResult } from "../shared";

export default {
  description:
    "Server reachability for the deploy app: probes a registered server over SSH, records the classified verdict, and exposes its verdict as the `status` field of every list of servers plus the verify step of the SSH setup flow.",
  contributions: [
    // The probe verdict as the `status` field of every list of servers.
    serverStatusPresentation,
    // The server pane's liveness, as a peer section of the identity block rather
    // than a micro-slot inside it. The verdict badge rides `summary`, so it is
    // readable with the card shut and the body is free to carry the probe's
    // detail (when it ran, why it failed).
    //
    // It has to be its own contribution: `servers` owns the identity section,
    // and `servers` cannot import `health` (health already imports servers for
    // the entity it exposes on — the reverse edge would close a cycle). The dependency
    // has always pointed this way, and that is the honest direction: the
    // registry owns a server's identity, this plugin owns its liveness.
    ServerDetail.Section({
      id: "status",
      label: "Status",
      component: ServerStatusSection,
      summary: ServerStatusSummary,
    }),
  ],
} satisfies PluginDefinition;
