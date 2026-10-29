import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  ServerDetail,
  ServerHeader,
} from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { serverStatusPresentation } from "./internal/status-presentation";
import { ServerStatusSection } from "./components/status-section";
import {
  CheckNowAction,
  ServerHeaderPlatform,
  ServerHeaderStatus,
} from "./components/server-header-parts";
import { ServersSidebarSection } from "./components/servers-sidebar";
import { Deploy } from "@plugins/apps/plugins/deploy/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

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
    "Server reachability for the deploy app: probes a registered server over SSH, records the classified verdict, and exposes its verdict as the `status` field of every list of servers plus the verify step of the SSH setup flow, and the Deploy sidebar's Servers section (each server with its verdict dot).",
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
      label: "Health",
      column: "side",
      component: ServerStatusSection,
      useDefaultOpen: () => true,
    }),
    ServerHeader.Badge({ id: "status", component: ServerHeaderStatus }),
    ServerHeader.Meta({ id: "platform", component: ServerHeaderPlatform }),
    ServerHeader.Action({ id: "check-now", component: CheckNowAction }),
    // The Deploy sidebar's Servers section, each row wearing this plugin's
    // verdict dot. Here rather than in `servers` for the same reason as the
    // section above: `servers` cannot import `health`.
    Deploy.Sidebar({
      id: "servers",
      title: "Servers",
      icon: symbol("dns"),
      component: ServersSidebarSection,
    }),
  ],
} satisfies PluginDefinition;
