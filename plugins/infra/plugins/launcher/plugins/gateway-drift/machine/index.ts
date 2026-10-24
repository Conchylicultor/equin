import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { gatewayDriftServed } from "./internal/served";
import { gatewayDriftReaction } from "./internal/reaction";

export default {
  description:
    "Gateway drift, desktop-only half: serves the gateway-drift push value — the machine's login-service gateway (installed launchd plist / systemd unit and the running process) compared with what ./equin start --force would install now from main (binary identity, every flag incl. -listen and -child-env, cwd, code signature), re-checked on every advance of main. Declared needsMachine, so a host without the computer answers it unavailable.",
  register: [gatewayDriftReaction],
  contributions: [...gatewayDriftServed.declare],
} satisfies MachinePluginDefinition;
