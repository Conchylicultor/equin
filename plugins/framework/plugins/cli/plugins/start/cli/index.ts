import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import { GATEWAY_PORT_RANGE } from "@plugins/infra/plugins/namespace/core";

/**
 * The one command that deliberately leaves something running after it exits —
 * the gateway daemon: a per-user OS service (launchd on macOS, a systemd user
 * unit on Linux) so it survives a reboot, spawned detached elsewhere.
 *
 * It is NOT `detachable`, though: what outlives the shell is the daemon, not
 * this process. `start` itself only builds the gateway, hands it to the service
 * manager (or spawns it), and waits for it to answer, so the orphan guard killing it when
 * its invoking shell dies is exactly right — an orphaned readiness wait has
 * nobody left to report to.
 *
 * A system-level, one-time operation: never part of the normal agent workflow.
 */
export default defineCliCommand<
  [],
  {
    force?: boolean;
    logLevel: string;
    only?: string;
    port?: string;
    verbose?: boolean;
  }
>({
  name: "start",
  description:
    "Build the gateway, register it to start by itself (login on macOS, boot on Linux), and start it — then every declared login service",
  options: [
    { flags: "--force", description: "Restart even if already running" },
    {
      flags: "--only <ids>",
      description: `Comma-separated services to start (the gateway's ${GATEWAY_SERVICE.label} — ${LEGACY_IDS.launchdLabel} on an install data-dir migrate has not moved yet — or a declared login service id); with --force, restarts only those`,
    },
    {
      flags: "--port <port>",
      description: `Move this account's equin to another port of ${GATEWAY_PORT_RANGE.first}–${GATEWAY_PORT_RANGE.last} (restarts it; open apps reload). Without it, the port chosen at the first start is kept — the first free one of that range`,
    },
    {
      flags: "--verbose",
      description:
        "Also print each step's detailed lines (always written to the start log)",
    },
    {
      flags: "--log-level <level>",
      description: "Gateway log level: debug|info|warn|error",
      defaultValue: "info",
    },
  ],
  run: () => import("./run"),
});
