import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  HOST_IO_DEGRADED_KIND,
  HostIoDegradedPayloadSchema,
  findingKey,
  type Finding,
  type IoHealthRule,
} from "../../core";

/** Where each rule sends the investigation first. */
const WHAT_TO_DO: Record<IoHealthRule, string> = {
  "daemon-cpu":
    "Find what the daemon is doing for whom. For fseventsd, a history replay for one client shows in the root monitor's `fseventsd_logs` (a log file far behind the newest, advancing tick after tick) and in `log show --predicate 'process == \"fseventsd\"'`; on 2026-11-03/04 the client was corecaptured, replaying from a purge marker that never advanced because `/Library/Logs/CoreCapture` and `/Library/Logs/CrashReporter/CoreCapture` were missing.",
  "device-latency":
    "Find who reads the disk: the root monitor's `disk_readers_mb_s` (top readers per tick) and `disk_read_attributed_mb_s`, or `census.py` without root. A system daemon at the top (fseventsd, syspolicyd, mds_stores) is the first suspect; a busy fleet alone keeps the device under 1 ms/op.",
  "metadata-stall":
    "The root monitor captured a 5 s `fs_usage -w -f filesys` sample at the stall (`incident` field of that tick, under `fs-latency-incidents/`): it names who was doing the lookups. Without root, compare the `fg` and `bg` probes: only `bg` slow is the darwinbg I/O throttle under load.",
  "relaunch-loop":
    "Read the daemon's own lines in the unified log (`log show --last 15m --predicate 'process == \"<name>\"'`) and `launchctl print system/<label>` (its `runs` count): what makes it exit, and what relaunches it. Each run may cost far more than the process itself (corecaptured's each replayed 17 days of FSEvents history).",
  "cache-collapse":
    "Something evicts the file cache without vnode churn: memory pressure (`vm_stat`, the memory compressor) or a process purging (`purge`, a cache-deleting daemon).",
};

function renderTask(row: ReportRow): { title: string; description: string } {
  const f: Finding = HostIoDegradedPayloadSchema.parse(row.data);
  const lines = [
    `The host file-I/O detector (\`infra/host/io-health\`, reading the fs-latency monitor's log) found a sustained degradation: **${f.summary}**, holding since ${new Date(f.since).toISOString()}.`,
    "",
    "Evidence (as of the latest occurrence):",
    ...f.evidence.map((e) => `- ${e.label}: ${e.value}`),
    "",
    `**What to do:** ${WHAT_TO_DO[f.rule]}`,
    "",
    "Read the monitor's history per hour with its `report.py` (`sidequests/monitors/fs-latency/CLAUDE.md`, *Read it*), and replay its log through the detector with `./equin run plugins/infra/plugins/host/plugins/io-health/scripts/replay-monitor-log.ts`. How the monitor was used on the 2026-11-03/04 incident is in the same CLAUDE.md.",
  ];
  return {
    title: `[host-io] ${f.summary}`,
    description: lines.join("\n"),
  };
}

/**
 * `host-io-degraded`: one finding of the host file-I/O detector — one row per
 * rule and subject (`daemon-cpu:fseventsd`, `device-latency:disk`, …),
 * recorded when it is raised and again every hour it holds (so the row's
 * `lastSeenAt` says it is still going).
 *
 * `duressExempt`: a degraded disk and a host in duress are often the same
 * event — the shed gate would buffer exactly the report that names the cause.
 * Volume is bounded without it: a closed set of rules, one row per subject,
 * at most one occurrence per finding per hour.
 */
export const hostIoDegradedKind = ReportKind({
  kind: HOST_IO_DEGRADED_KIND,
  schema: HostIoDegradedPayloadSchema,
  fingerprint: (f: Finding) => `${HOST_IO_DEGRADED_KIND}:${findingKey(f)}`,
  duressExempt: true,
  meta: {
    tag: "[host-io]",
    notif: "This machine's file I/O is degraded",
    variant: "warning",
    // A standing condition re-recorded hourly: re-ring at most every 6 h.
    notifCooldownMs: 6 * 60 * 60_000,
  },
  renderTask,
});
