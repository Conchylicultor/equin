import type { LoginServiceId } from "../../core";
import { launchdManager } from "./launchd";
import type { LoginService, LoginServiceManager } from "./login-service";
import { systemdManager } from "./systemd";

/**
 * The service manager this host has, or null when there is none (a container
 * without systemd, an unsupported OS): `start` then spawns the gateway
 * detached, which does not survive a reboot, and registers no other service.
 */
export function loginServiceManager(): LoginServiceManager | null {
  if (process.platform === "darwin") return launchdManager;
  if (process.platform === "linux" && Bun.which("systemctl") !== null)
    return systemdManager;
  return null;
}

/** The service `id` under this host's manager (bound), or null when it has none. */
export async function loginService(
  id: LoginServiceId,
): Promise<LoginService | null> {
  const manager = loginServiceManager();
  return manager === null ? null : manager.service(id);
}
