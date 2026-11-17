import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  DRAIN_SLOW_REPORT_KIND,
  DrainSlowPayloadSchema,
  drainSlowFingerprint,
  drainSlowMessage,
} from "../../core";

// `main-slot-drain-slow`, filed by `reclaimSlots` (cli/: the end of every
// main build, the daily main-slots.reclaim job) per holder that kept a slot
// past its app's switch by more than the threshold. One row per (holder
// kind, label): the job is what to fix, its occurrences count the drains.
export const drainSlowKind = ReportKind({
  kind: DRAIN_SLOW_REPORT_KIND,
  schema: DrainSlowPayloadSchema,
  fingerprint: (data) =>
    drainSlowFingerprint(DrainSlowPayloadSchema.parse(data)),
  meta: {
    tag: "[main-slots]",
    notif: "A process kept an old slot of main busy",
    variant: "warning",
    category: "slow-op",
  },
  renderTask: (row: ReportRow) => {
    const d = DrainSlowPayloadSchema.parse(row.data);
    const who = `${d.kind}${d.label === null ? "" : ` \`${d.label}\``}`;
    return {
      title: `[main-slots] ${d.kind}${d.label === null ? "" : ` ${d.label}`} keeps an old slot busy after deploys`,
      description: [
        drainSlowMessage(d),
        "",
        `Main and its compositions each run from the slot they were built in (\`infra/git/main-slots\`). When an app switches to a newer slot, the old one drains: what it left running there finishes, and the slot is freed for the next build. ${who} kept it past the ${Math.round(d.thresholdMs / 1000)} s threshold (config \`main-slots.drainReportAfterSec\`).`,
        "",
        "The fix is in that job: make it faster, or stop it outliving the app that started it (a supervised child is detached on purpose — does this one need to be?).",
        "",
        `- Slot: \`${d.slot}\`${d.commit === null ? "" : ` at \`${d.commit.slice(0, 9)}\``}`,
        `- Held past the switch: ${Math.round(d.heldPastSwitchMs / 1000)} s${d.stillHolding ? " (still holding when reclaim ran)" : d.foundDead ? " at least (last seen alive then; killed while holding)" : ""}`,
        `- Pid: ${d.pid}`,
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
