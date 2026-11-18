/** The monitor's launchd label: its login service (a user LaunchAgent) and, opted into, its root daemon. */
export const FS_LATENCY_MONITOR_LABEL = "dev.equin.fs-latency-monitor";

/** The command that installs (or refreshes) the monitor as a login service. */
export const START_MONITOR_COMMAND = `./equin start --only ${FS_LATENCY_MONITOR_LABEL}`;

/**
 * The OSes the monitor exists on: its login service's `platforms`, and the
 * ones where the Disk I/O row expects its log. Anywhere else the row says the
 * disk is not measured ({@link FS_LATENCY_MONITOR_PLATFORM_REASON}), instead
 * of asking for a monitor `./equin start` cannot install.
 */
export const FS_LATENCY_MONITOR_PLATFORMS: readonly NodeJS.Platform[] = [
  "darwin",
];

/** Why the monitor exists nowhere else, in a user's words. */
export const FS_LATENCY_MONITOR_PLATFORM_REASON =
  "this check reads disk statistics only macOS keeps";
