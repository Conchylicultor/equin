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
    "Find what the daemon is doing for whom. For fseventsd, a history replay for one client shows in the root monitor's `fseventsd_logs` (a log file far behind the newest, advancing tick after tick) and in `log show --predicate 'process == \"fseventsd\"'`; on 2026-11-03/04 the client was corecaptured, replaying from a purge marker that never advanced because `/Library/Logs/CoreCapture` and `/Library/Logs/CrashReporter/CoreCapture` were missing. A CacheDelete client replays the same way on each launch (`log show --predicate 'eventMessage CONTAINS \"consuming stream\"'` names it and its `from ID`; photolibraryd for 7 min twice on 2026-11-08). With no replay, look for a flood first (an `fsevents-flood` finding now or in the hours before; once fseventsd pins, its throughput, and so the id rate, falls to 1–3k/s, so the flood may only show earlier). On 2026-11-08 and 11-09/10 the pin was three orphaned create/unlink loops (a repro's churn child) generating 50–150k events/s for 25 h: fseventsd's per-path event table grew into tens of GB (`rss_mb` stays small; `top -pid <pid> -stats mem,cmprs` shows the footprint) and jetsam killed it at 82 and 97 GB, each relaunch destroying the FSEvents history (research/2026-11-10-global-fseventsd-relapse-orphaned-churn.md). Stopping the writer took it from 170 % to 2 % CPU at once; only a restart (`sudo killall fseventsd`, the user's call) returns the memory.",
  "device-latency":
    "Find who reads the disk: the root monitor's `disk_readers_mb_s` (top readers per tick) and `disk_read_attributed_mb_s`, or `census.py` without root. A system daemon at the top (fseventsd, syspolicyd, mds_stores) is the first suspect; a busy fleet alone keeps the device under 1 ms/op.",
  "metadata-stall":
    "The root monitor captured a 5 s `fs_usage -w -f filesys` sample at the stall (`incident` field of that tick, under `fs-latency-incidents/`): it names who was doing the lookups. Without root, compare the `fg` and `bg` probes: only `bg` slow is the darwinbg I/O throttle under load.",
  "rename-stall":
    "A rename anywhere on the volume waits while another process mutates a directory tree in bulk: measured 2026-11-05, every `bun install` (package dirs moved into place) and `rm -rf` of a `node_modules` held the probe's renames 0.3–1.3 s, at any I/O tier, and a darwinbg install runs 8–16× longer, so it holds them that much longer. Main's `renameSync` calls (`writeAtomic`, `cloneNamedBinary`) stall with it. The `in uninterruptible wait then` line names who was stuck beside the probe; as root, a rename over 1 s also takes the `fs_usage` capture (`incident`), which names who was renaming and removing. Find what installs or deletes trees that often (worktree spare refill, worktree removal, agents' installs).",
  "relaunch-loop":
    "Read the daemon's own lines in the unified log (`log show --last 15m --predicate 'process == \"<name>\"'`) and `launchctl print system/<label>` (its `runs` count): what makes it exit, and what relaunches it. Each run may cost far more than the process itself (corecaptured's each replayed 17 days of FSEvents history).",
  "cache-collapse":
    "Something evicts the file cache without vnode churn: memory pressure (`vm_stat`, the memory compressor) or a process purging (`purge`, a cache-deleting daemon).",
  "fsevents-flood":
    "Find the writer. Count FSEvents by path for a minute with a user-level client on `/` (`kFSEventStreamCreateFlagFileEvents | UseCFTypes`, latency 0.2 s; the Swift counter in research/2026-11-10-global-fseventsd-relapse-orphaned-churn.md): a handful of paths taking nearly every event is one loop. Then find its process: `ps -axo pid,ppid,lstart,time,command` — on 2026-11-09 it was three `node -e` churn children orphaned (ppid 1) by a crash repro whose parent segfaulted as designed, 99 % of the machine's events for 25 h. A sustained flood makes fseventsd grow until jetsam kills it (82–97 GB), and each kill destroys the FSEvents history every client resumes from.",
  "root-daemon":
    "Run the evidence's reinstall command (sudo, from any directory): it renders the plist to a temporary file, checks it with `plutil -lint`, moves it into place and bootstraps it, or leaves nothing installed. For `not-writing`, read the daemon's own log (evidence) and `sudo launchctl print system/dev.equin.fs-latency-monitor` (`last exit code`). Not wanted any more: `uninstall-root` (the monitor's CLAUDE.md, *Root*).",
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
    "Read the monitor's history per hour with its `report.ts` (`plugins/infra/plugins/host/plugins/io-health/plugins/monitor/CLAUDE.md`, *Read it*), and replay its log through the detector with `./equin run plugins/infra/plugins/host/plugins/io-health/scripts/replay-monitor-log.ts`.",
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
