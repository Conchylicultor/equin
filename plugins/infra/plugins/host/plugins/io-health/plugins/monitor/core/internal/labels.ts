/** The monitor's launchd label: its login service (a user LaunchAgent) and, opted into, its root daemon. */
export const FS_LATENCY_MONITOR_LABEL = "dev.equin.fs-latency-monitor";

/** The command that installs (or refreshes) the monitor as a login service. */
export const START_MONITOR_COMMAND = `./equin start --only ${FS_LATENCY_MONITOR_LABEL}`;
