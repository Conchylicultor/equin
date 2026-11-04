/** The monitor's launchd label: its login service (a user LaunchAgent) and, opted into, its root daemon. */
export const FS_LATENCY_MONITOR_LABEL = "dev.equin.fs-latency-monitor";

/**
 * The label the monitor ran under as a hand-installed sidequest
 * (`sidequests/monitors/fs-latency`, 2026-11-03 → its migration). While its
 * root daemon is still installed, the login service stands aside for it.
 */
export const LEGACY_MONITOR_LABEL = "com.epot.fs-latency-monitor";

/** Where a root LaunchDaemon of `label` is installed. */
export function rootDaemonPlist(label: string): string {
  return `/Library/LaunchDaemons/${label}.plist`;
}

/**
 * The root daemons the user agent defers to while one is installed: one writer
 * per log, and the root one also attributes reads to processes.
 */
export const ROOT_DAEMON_PLISTS: readonly string[] = [
  rootDaemonPlist(FS_LATENCY_MONITOR_LABEL),
  rootDaemonPlist(LEGACY_MONITOR_LABEL),
];

/** The command that installs (or refreshes) the monitor as a login service. */
export const START_MONITOR_COMMAND = `./equin start --only ${FS_LATENCY_MONITOR_LABEL}`;
