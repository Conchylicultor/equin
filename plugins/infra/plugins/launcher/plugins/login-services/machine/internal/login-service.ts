import type { LoginServiceId, LoginServiceJob } from "../../core";

/**
 * One per-user OS service, bound to its id — what makes a process come back
 * after a reboot (or a login) and relaunches it when it dies.
 *
 * One interface, one implementation per service manager: launchd on macOS
 * (`launchd.ts`), a systemd user unit on Linux (`systemd.ts`). `./equin start`
 * / `stop` drive whichever this host has through it and never name a manager,
 * so a new one is a new implementation, not a new branch in every command.
 *
 * Bound to an id (label + session), not to a job: `stop` needs to find and
 * unload a service without ensuring the binary it runs, and `write` takes the
 * job alone, so a job written under another service's label has no spelling.
 *
 * Every one is a per-USER service, never a system-wide daemon: the runtime is
 * one instance per user, and initdb refuses to run as root.
 */
export interface LoginService {
  readonly id: LoginServiceId;
  /** The service manager, as a user reads it in a message ("launchd", "systemd"). */
  readonly manager: string;
  /** When the manager starts the service on its own. */
  readonly startsAt: "login" | "boot";
  /** The job definition file this service writes. */
  definitionPath(): string;
  /** What the manager currently holds for the service. */
  state(): Promise<LoginServiceState>;
  /**
   * Write the job definition. Returns whether the file changed — neither
   * manager re-reads a definition while the job is loaded, so a change takes
   * effect on the next `unload` + `load`.
   *
   * 0600: a declared environment may carry credentials (the gateway's carries
   * OAuth client secrets).
   */
  write(job: LoginServiceJob): { path: string; changed: boolean };
  /** Delete the definition, so the service no longer starts by itself. */
  remove(): Promise<boolean>;
  /** Load (and so start) the written job; resolves with its pid once it runs. */
  load(): Promise<number>;
  /** Stop the service through the manager. The definition stays. */
  unload(): Promise<void>;
}

export type LoginServiceState =
  | { kind: "not-loaded" }
  /** Loaded; `pid` is null while it is not running (throttled between relaunches, or stopped after a clean exit). */
  | { kind: "loaded"; pid: number | null; lastExit: string | null };

/** A service manager: hands out a bound {@link LoginService} per id. */
export interface LoginServiceManager {
  readonly manager: string;
  service(id: LoginServiceId): LoginService;
}
