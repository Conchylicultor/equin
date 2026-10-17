import type { gatewayLaunchSpec } from "./boot";

/**
 * The gateway as a per-user OS service — what makes the app come back after a
 * reboot and relaunches the gateway when it dies.
 *
 * One interface, one implementation per service manager: launchd on macOS
 * (`launchd-service.ts`), a systemd user unit on Linux (`systemd-service.ts`).
 * `./singularity start` / `stop` drive whichever this host has through it and
 * never name a manager, so a new one is a new implementation, not a new branch
 * in every command.
 *
 * Both are per-USER services, never a system-wide daemon: the runtime is one
 * instance per user, and initdb refuses to run as root.
 */
export interface GatewayLoginService {
  /** The service manager, as a user reads it in a message ("launchd", "systemd"). */
  manager: string;
  /** When the manager starts the gateway on its own. */
  startsAt: "login" | "boot";
  /** The job definition file this service writes. */
  definitionPath(): string;
  /** What the manager currently holds for the gateway. */
  state(): Promise<GatewayServiceState>;
  /**
   * Write the job definition for `spec`. Returns whether the file changed —
   * neither manager re-reads a definition while the job is loaded, so a change
   * takes effect on the next `unload` + `load`.
   *
   * 0600: the declared runtime environment carries OAuth client credentials.
   */
  write(spec: ReturnType<typeof gatewayLaunchSpec>): {
    path: string;
    changed: boolean;
  };
  /** Delete the definition, so the gateway no longer starts by itself. */
  remove(): Promise<boolean>;
  /** Load (and so start) the written job; resolves with its pid once it runs. */
  load(): Promise<number>;
  /** Stop the gateway through the manager. The definition stays. */
  unload(): Promise<void>;
}

export type GatewayServiceState =
  | { kind: "not-loaded" }
  /** Loaded; `pid` is null while it is not running (throttled between relaunches, or stopped after a clean exit). */
  | { kind: "loaded"; pid: number | null; lastExit: string | null };

/** The one service label, shared by every manager. */
export const GATEWAY_SERVICE_LABEL = "dev.singularity.gateway";
