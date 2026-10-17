import { launchdGatewayService } from "./launchd-service";
import { systemdGatewayService } from "./systemd-service";
import type { GatewayLoginService } from "./gateway-service";

/**
 * The service manager this host has, or null when there is none (a container
 * without systemd, an unsupported OS): `start` then spawns the gateway
 * detached, which does not survive a reboot.
 */
export function gatewayLoginService(): GatewayLoginService | null {
  if (process.platform === "darwin") return launchdGatewayService;
  if (process.platform === "linux" && Bun.which("systemctl") !== null)
    return systemdGatewayService;
  return null;
}
