import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  FLEET_MEMORY_UNMEASURED_KIND,
  FleetMemoryUnmeasuredPayloadSchema,
  fleetMemoryUnmeasuredFingerprint,
  fleetMemoryUnmeasuredMessage,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";

/** The `fleet-memory-unmeasured` report kind — see host-admission's CLAUDE.md. */
export const fleetMemoryUnmeasuredKind = ReportKind({
  kind: FLEET_MEMORY_UNMEASURED_KIND,
  schema: FleetMemoryUnmeasuredPayloadSchema,
  fingerprint: fleetMemoryUnmeasuredFingerprint,
  meta: {
    tag: "[host-admission]",
    notif: "Host admission is running without a memory reading",
    variant: "warning",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = FleetMemoryUnmeasuredPayloadSchema.parse(row.data);
    return {
      title:
        d.cause === "absent"
          ? "No fleet memory reading: cpu grants admitted unmeasured"
          : "Fleet memory reading went stale: cpu grants admitted unmeasured",
      description: [
        fleetMemoryUnmeasuredMessage(d),
        "",
        `- Acquired by: pid ${d.pid}, \`${d.command}\` (${d.lane} lane)`,
        `- Last reading's age: ${d.ageMs === null ? "none ever written" : `${Math.round(d.ageMs / 1000)} s`}`,
        `- Window admitted on: ${d.slots} slots (one background, one reserved interactive)`,
        "",
        "Every `cpu` grant is sized from main's owner sampler reading (`locks/fleet-memory/fleet-memory.json`, every 30 s; `plugins/debug/plugins/sentinel/plugins/machine-usage`). Without one, admission cannot see the machine and holds the agent fleet to one op at a time. Find out why the sampler stopped writing (main down or restarting for over 2 min? the `machine-usage.owner-sampler` timer failing?) — the floor is a safe stand-in, not a mode to live in.",
      ].join("\n"),
    };
  },
});
