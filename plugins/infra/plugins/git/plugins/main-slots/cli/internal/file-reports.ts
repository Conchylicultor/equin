import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import {
  DRAIN_SLOW_REPORT_KIND,
  drainSlowMessage,
  SLOTS_EXHAUSTED_REPORT_KIND,
  type DrainSlowPayload,
  type SlotsExhaustedPayload,
} from "../../core";
import type { HeldSlot } from "./acquire-build-slot";

// The CLI's half of main-slots' report kinds (declared in `server/`): filed
// through the outbox — a CLI process has no database of its own. A report
// that could not be written is said on stderr (`fileReportFromProcess`
// prints why) — never a reason to fail the build that files it.

/**
 * `acquireBuildSlot`'s default `onExhausted`: a `main-slots-exhausted`
 * report naming every draining slot's holders, then the build waits.
 */
export function fileOnExhausted(
  limit: number,
): (
  draining: HeldSlot[],
  waitedOn: AppPath,
  waitingMs: number,
) => Promise<void> {
  return async (draining, waitedOn, waitingMs) => {
    const data: SlotsExhaustedPayload = {
      limit,
      waitedOn,
      waitingMs,
      slots: draining.map((d) => ({
        slot: d.slot,
        unservedAt: d.unservedAt,
        holders: d.holders,
      })),
    };
    const waiting =
      waitingMs === 0
        ? "waiting on"
        : `still waiting, after ${Math.round(waitingMs / 60_000)} min, on`;
    const message = `no free slot of main's pool and ${draining.length} draining (the leak limit, ${limit}) — ${waiting} ${waitedOn}: ${draining
      .map(
        ({ slot, holders }) =>
          `${slot} [${holders.map((h) => `${h.pid} ${h.kind}${h.label === null ? "" : ` ${h.label}`}`).join(", ") || "no live holder recorded"}]`,
      )
      .join("; ")}`;
    console.error(`[main-slots] ${message}`);
    const filed = await fileReportFromProcess({
      kind: SLOTS_EXHAUSTED_REPORT_KIND,
      message,
      data,
    });
    if (filed.outcome === "written")
      console.error(
        `[main-slots] filed a ${SLOTS_EXHAUSTED_REPORT_KIND} report`,
      );
  };
}

/** `reclaimSlots`' default filer: one `main-slot-drain-slow` report. Whether it was written. */
export async function fileDrainSlow(data: DrainSlowPayload): Promise<boolean> {
  const message = drainSlowMessage(data);
  console.error(`[main-slots] ${message}`);
  const filed = await fileReportFromProcess({
    kind: DRAIN_SLOW_REPORT_KIND,
    message,
    data,
  });
  return filed.outcome === "written";
}
