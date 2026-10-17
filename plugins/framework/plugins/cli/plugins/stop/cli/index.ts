import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * Stop the gateway daemon `./singularity start` left running. Where the
 * gateway is an OS service (launchd on macOS, a systemd user unit on Linux) it
 * relaunches when it dies, so killing its pid is not a stop — this is. A system-level operation like `start`: never part of
 * the agent workflow.
 */
export default defineCliCommand<[], { disable?: boolean }>({
  name: "stop",
  description: "Stop the gateway daemon",
  options: [
    {
      flags: "--disable",
      description:
        "Also stop it from starting by itself (at login on macOS, at boot on Linux)",
    },
  ],
  run: () => import("./run"),
});
