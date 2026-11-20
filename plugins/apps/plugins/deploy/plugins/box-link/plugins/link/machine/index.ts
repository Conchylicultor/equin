import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { boxLinkRetryEndpoint } from "../core";
import { boxLinksServed, siteHealthServed } from "./internal/served";
import { boxLinkSocketWatcher, boxLinkTunnelDaemon } from "./internal/tunnel";
import { handleBoxLinkRetry } from "./internal/retry";
import { startBoxLinks, stopBoxLinks } from "./internal/link-manager";

export default {
  description:
    "The permanent link from this computer to each deployed site's box. Real boxes are linked from main only — one SSH tunnel per server (a deploy.box-link.tunnel daemon, respawned forever 2 s → 2 min, ready once its forwards' sockets appear, stopped on a refusal no respawn can fix), one forward per deployment — and a demo's stand-in boxes from every namespace, through this instance's own gateway. One stream client per deployment reads the box's host-only NDJSON stream (45 s watchdog, bounded reconnect backoff) into the pure reducer (connecting / live / reconnecting with its cause and a 2 min grace / down / unreachable / refused / outdated), served from memory as deploy.box-links and persisted on a state change only. Folds each deployment's link, newest deploy run and running commit into the one deploy.site-health value. A wake respawns every tunnel and reconnects every stream; POST /api/box-link/:deploymentId/retry does it for one link. What it links follows the targets NOTIFY.",
  contributions: [...boxLinksServed.declare, ...siteHealthServed.declare],
  register: [boxLinkTunnelDaemon, boxLinkSocketWatcher],
  httpRoutes: {
    [boxLinkRetryEndpoint.route]: handleBoxLinkRetry,
  },
  onReady: startBoxLinks,
  onShutdown: stopBoxLinks,
} satisfies MachinePluginDefinition;
