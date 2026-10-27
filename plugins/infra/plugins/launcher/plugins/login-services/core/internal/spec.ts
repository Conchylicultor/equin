/**
 * Which session a login service belongs to — the one thing that differs
 * between the two kinds of per-user service this host runs:
 *
 * - `"background"` — runs whether or not anyone sits at the screen (the
 *   gateway). launchd: a plain LaunchAgent in `gui/<uid>`, started at login.
 *   systemd: a user unit `WantedBy=default.target`, which needs lingering, and
 *   then starts at BOOT.
 * - `"graphical"` — needs the user's desktop session (a menu-bar icon, a
 *   window). launchd: `LimitLoadToSessionType=Aqua`. systemd: `PartOf=` /
 *   `After=` / `WantedBy=graphical-session.target`, so it starts with the
 *   desktop and stops with it; no lingering needed.
 */
export type LoginServiceSession = "background" | "graphical";

/** Which service a manager is asked about: what `stop` knows without ensuring anything. */
export interface LoginServiceId {
  /** The service label (launchd `Label`, systemd unit name stem), e.g. the gateway's `dev.equin.gateway`. */
  label: string;
  session: LoginServiceSession;
  /**
   * Labels the service was installed under before it was renamed. While the
   * definition of one of them is still installed, the manager binds the
   * service to THAT label (its `id.label` reads it): an installed service is
   * renamed only by whoever moves it over — `./equin data-dir migrate` for the
   * gateway — never by new code that happens to spell a new name, which would
   * register a second copy of the service beside the running one.
   */
  installedAs?: readonly string[];
}

/** What the service runs — computed only once its binary is ensured. */
export interface LoginServiceJob {
  /** One line, as a user reads it in `systemctl status`. */
  description: string;
  argv: readonly string[];
  cwd: string;
  /** The service's whole environment: nothing is inherited from whoever ran `start`. */
  env: Readonly<Record<string, string>>;
  /** stdout and stderr both land here (appended by the manager). */
  stdioLog: string;
}

/** A per-user OS service as data: what both renderers and both managers take. */
export type LoginServiceSpec = LoginServiceId & LoginServiceJob;
