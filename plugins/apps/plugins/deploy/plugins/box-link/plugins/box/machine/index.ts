import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { boxLinkStreamEndpoint } from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import { handleBoxLinkStream } from "./internal/stream";

export default {
  description:
    "The box's link stream, desktop-only: GET /api/host-only/box-link/stream, behind hostOnly — the NDJSON stream (protocol v1) a computer holds open to its box: it subscribes to every BoxSignal contribution, then says hello (protocol version, backend start, the commit its served bundle was built from, the signal sources), then beats at once and every 15 s with the host's metrics (CPU busy share since the stream's previous beat — /proc/stat on Linux, os.cpus() elsewhere, null on the first beat — cores, 1-minute load, memory in use and total, the install filesystem's used and total, uptime) and relays each signal as { source, payload }. A reader leaving aborts the producer, which drops every subscription and its timer.",
  httpRoutes: {
    [boxLinkStreamEndpoint.route]: handleBoxLinkStream,
  },
} satisfies MachinePluginDefinition;
