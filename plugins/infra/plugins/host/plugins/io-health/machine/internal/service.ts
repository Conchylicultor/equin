import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { monitorLogsDir } from "@plugins/debug/data-dirs";
import { FS_LATENCY_LOG_NAME, HOST_IO_DEGRADED_KIND } from "../../core";
import { readLogTail } from "./log-tail";
import { createIoHealthState } from "./io-health-state";

export const fsLatencyLogWatcher = defineFileWatcher({
  name: "io-health.fs-latency-log",
  description:
    "Reads each tick the fs-latency monitor appends to its log, so host disk health (the Disk I/O health row, host-io-degraded reports) follows the monitor within one tick.",
  // Only the monitors' directory itself: the probe corpus and incident
  // captures below it are not ours to hear.
  depth: "children",
});

const logPath = (): string => monitorLogsDir.file(FS_LATENCY_LOG_NAME);

export const ioHealthState = createIoHealthState({
  read: (cursor) => readLogTail(logPath(), cursor),
  record: async (f) => {
    await recordReport({
      kind: HOST_IO_DEGRADED_KIND,
      source: "server-host-io-monitor",
      message: f.summary,
      data: f,
    });
  },
  // The log is host-global: one backend files, the others only show it.
  files: isMain(),
  now: () => Date.now(),
});

// Refreshes are serialized (the state holds one cursor); a tick landing
// mid-refresh is owed one more.
const refreshes = createCoalescer({
  run: () => runTracked("io-health:refresh", () => ioHealthState.refresh()),
});

/** Read the log now, serialized with the watcher's refreshes. */
export function refreshIoHealth(): Promise<unknown> {
  return refreshes.run();
}

let watcher: FileWatcher | null = null;

/**
 * Follow the monitor's log for as long as the backend serves: read its tail
 * now, then once per change of the monitors' directory. No timer — the
 * monitor's own launchd schedule is the clock; the log not moving is what the
 * health row reads as "stopped".
 */
export async function startIoHealth(): Promise<void> {
  if (watcher) return;
  watcher = await fsLatencyLogWatcher.start({
    dirs: [monitorLogsDir.ensure()],
    onChange: (events) =>
      events.some((e) => e.path.endsWith(`/${FS_LATENCY_LOG_NAME}`))
        ? refreshes.run()
        : undefined,
  });
  // After subscribing, so a tick written between the read and the subscription is not missed.
  await refreshes.run();
}

export async function stopIoHealth(): Promise<void> {
  const w = watcher;
  watcher = null;
  await w?.stop();
}
