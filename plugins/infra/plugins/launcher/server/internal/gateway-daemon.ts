import { defineDaemon } from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { GATEWAY_PID_FILENAME, gatewayLocks } from "../../data-dirs";

/**
 * The Go gateway this backend runs behind. Not started by the backend — the
 * CLI (`./equin start`), launchd or the release launcher starts it, and
 * it is the gateway that starts the backend — so it is attached by its pid
 * file, never respawned from here.
 */
export const gatewayDaemon = defineDaemon({
  name: "launcher.gateway",
  description:
    "The Go gateway every browser request goes through: it routes *.localhost:9000 to each backend's socket, and starts and watches the backends, Postgres and PgBouncer. Started by ./equin start, launchd or the release launcher, not by this backend.",
  startedBy: "boot",
  where: "every-worktree",
  restart: { kind: "never" },
});

/** Follow the gateway under THIS process's data root for the backend's life. */
export function attachGateway(): void {
  gatewayDaemon.attach({ pidFile: gatewayLocks.file(GATEWAY_PID_FILENAME) });
}
