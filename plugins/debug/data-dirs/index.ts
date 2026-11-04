import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Output of the host-level launchd monitors in `sidequests/monitors/` — the
 * watchers that observe the machine from OUTSIDE the app, for failures the
 * app's own observability cannot survive (an FD leak before the crash, a
 * worktree checkout deleted under a live conversation).
 *
 * Declared here, by the debug umbrella, because the sidequest monitors are
 * scripts run by launchd: they are outside the build, import nothing, and so
 * can declare nothing themselves. The fs-latency monitor, now equin's own
 * (`infra/host/io-health/monitor`), is handed this directory on argv by its
 * login service, and keeps writing here so its history stays in one place. An undeclared directory written by a process the registry
 * cannot see is exactly the orphan this registry exists to prevent, and the
 * closest thing to an owner is the plugin family whose surfaces the monitors
 * exist to back up. The scripts spell the path; this declaration is what keeps
 * a sweep from treating it as unowned.
 */
export const monitorLogsDir = defineDataDir({
  kind: "logs",
  name: "monitors",
  owner: "debug",
  description:
    "Output of the host-level launchd monitors (sidequests/monitors/' FD-leak watcher; the fs-latency monitor of infra/host/io-health/monitor, its rotated archives included — read live by infra/host/io-health) — observability from outside the app",
  // Observability output written by a process nothing in the app supervises.
  // Losing it costs the record of a past host-level incident, never anything a
  // running monitor needs.
  reclaim: { kind: "safe" },
  logs: [
    {
      pattern: "fd-monitor.log",
      bound: {
        kind: "rotates-itself",
        how: "fd-monitor.sh moves it to fd-monitor.log.1 past 200k lines, keeping one",
      },
    },
    {
      pattern: "**",
      bound: {
        kind: "debt",
        reason:
          "the other sidequests/monitors jobs (fs-latency, worktree-removal, fseventsd captures) append forever",
        task: "task-1793827125-kkjagx",
      },
    },
  ],
});

export default [monitorLogsDir];
