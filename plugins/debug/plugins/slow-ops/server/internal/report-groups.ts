import type { SlowOpReportPayload } from "../../core";
import type { RecordSlowOpInput, SlowOpSource } from "./input";

/** The operation a burst report is filed under: `slow-op:<kind>:burst`. */
export const BURST_OPERATION = "burst";

/** How many of a burst's ops its report names (slowest first). */
export const BURST_NAMED_CAP = 10;

/** One report to file: its payload, source and one-line message. */
export interface SlowOpReport {
  source: SlowOpSource;
  data: SlowOpReportPayload;
  message: string;
}

/**
 * A batch's admitted items → the reports they file: ONE per operationKind.
 *
 * A batch is one instant's evidence — a client batch is one tab's 250 ms
 * window, already sharing one trace per kind (`toRecordInputs`). Items of one
 * kind in it are one incident: a stalled socket delivers every pending update
 * late, a page boot settles every element late. (Counted over DISTINCT
 * operations: one op tripping twice is still that op's own report.) Filing each as its own
 * fingerprint turned one cause into N notifications (14 `update`s at 14:14:24
 * on main, 8 `element`s at 14:08:50, 2026-10-30). So a kind with one item files
 * its own report, as before; a kind with several files one `burst` report,
 * standing for its slowest item (whose trace, waits and duration it carries)
 * and naming the others. Rows are unaffected — every item still lands on its
 * own op's row.
 *
 * Server spans reach the funnel one per batch, so they always file their own.
 */
export function reportsFor(
  inputs: readonly RecordSlowOpInput[],
): SlowOpReport[] {
  const byKind = new Map<string, RecordSlowOpInput[]>();
  for (const input of inputs) {
    const group = byKind.get(input.operationKind);
    if (group) group.push(input);
    else byKind.set(input.operationKind, [input]);
  }
  const reports: SlowOpReport[] = [];
  for (const group of byKind.values()) {
    // One entry per distinct operation — its slowest trip. The same op tripping
    // twice in a batch (two tuples of one resource) is still that op, not a
    // burst: it keeps its own fingerprint.
    const byOp = new Map<string, RecordSlowOpInput>();
    for (const input of group) {
      const seen = byOp.get(input.operation);
      if (!seen || input.ownMs > seen.ownMs) byOp.set(input.operation, input);
    }
    const sorted = [...byOp.values()].sort((a, b) => b.ownMs - a.ownMs);
    const slowest = sorted[0]!;
    if (sorted.length === 1) {
      reports.push({
        source: slowest.source,
        data: payloadOf(slowest, slowest.operation),
        message:
          `${slowest.operationKind} ${slowest.operation} took ${took(slowest)}` +
          ` (threshold ${slowest.thresholdMs}ms)`,
      });
      continue;
    }
    const named = sorted.slice(0, BURST_NAMED_CAP);
    reports.push({
      source: slowest.source,
      data: {
        ...payloadOf(slowest, BURST_OPERATION),
        burst: {
          count: sorted.length,
          operations: named.map((i) => ({
            operation: i.operation,
            ownMs: Math.round(i.ownMs),
          })),
        },
      },
      message:
        `${slowest.operationKind} burst: ${sorted.length} ops at once, the ` +
        `slowest ${slowest.operation} ${took(slowest)} ` +
        `(threshold ${slowest.thresholdMs}ms) — ` +
        named.map((i) => i.operation).join(", ") +
        (sorted.length > named.length
          ? `, +${sorted.length - named.length} more`
          : ""),
    });
  }
  return reports;
}

function payloadOf(
  input: RecordSlowOpInput,
  operation: string,
): SlowOpReportPayload {
  const { operationKind, durationMs, ownMs, thresholdMs } = input;
  return {
    operationKind,
    operation,
    durationMs,
    ownMs,
    thresholdMs,
    // Optional cold-start attribution — surfaced in the report title/desc.
    ...(input.transportColdStart !== undefined && {
      transportColdStart: input.transportColdStart,
    }),
    // This trip's per-layer split, so the description can name the layer the
    // time went to (the row's `waits` are cumulative, not this trip's).
    ...(input.waits !== undefined && { waits: input.waits }),
    // Optional link to the coherent-instant trace captured for this trip.
    ...(input.traceId !== undefined && { traceId: input.traceId }),
  };
}

/** `1502ms of its own (2500ms wall)`, or the one duration when nothing was excluded. */
function took(input: RecordSlowOpInput): string {
  const wall = Math.round(input.durationMs);
  const own = Math.round(input.ownMs);
  return own === wall ? `${wall}ms` : `${own}ms of its own (${wall}ms wall)`;
}
