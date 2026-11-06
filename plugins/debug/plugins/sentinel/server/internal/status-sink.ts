import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { SentinelStatus } from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import { createStatusWriter } from "@plugins/debug/plugins/sentinel/plugins/status-file/server";

export type DownStatus = Extract<SentinelStatus, { state: "down" }>;

/**
 * Where main's watcher host sends every supervision transition: the host-global
 * status file (every backend's health row reads it), and — on `down` — the
 * `sentinel-down` report (bell, Debug → Reports, Timeline).
 *
 * The report is filed before the file is written, so a failing write cannot
 * swallow the one signal that must land.
 */
export function createStatusSink(opts: {
  dir: AppPath;
  pid?: number;
  claimedAt?: number;
  reportDown: (status: DownStatus) => void;
}): (status: SentinelStatus) => Promise<void> {
  const write = createStatusWriter(opts.dir, {
    ...(opts.pid === undefined ? {} : { pid: opts.pid }),
    ...(opts.claimedAt === undefined ? {} : { claimedAt: opts.claimedAt }),
  });
  return (status) => {
    if (status.state === "down") opts.reportDown(status);
    return write(status);
  };
}
