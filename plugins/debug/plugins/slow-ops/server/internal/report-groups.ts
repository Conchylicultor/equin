import type { SlowOpReportPayload } from "../../core";
import type { RecordSlowOpInput, SlowOpSource } from "./input";

/** How many of a burst's ops each member's report names (slowest first). */
export const BURST_NAMED_CAP = 10;

/** One report to file: its payload, source and one-line message. */
export interface SlowOpReport {
  source: SlowOpSource;
  data: SlowOpReportPayload;
  message: string;
}

/**
 * A batch's admitted items → its incidents: ONE per operationKind, each the
 * reports it files, slowest first — one per distinct operation (its slowest
 * trip; one op tripping twice is still that op).
 *
 * A batch is one instant's evidence — a client batch is one tab's 250 ms
 * window, already sharing one trace per kind (`toRecordInputs`). Items of one
 * kind in it are one incident: a stalled socket delivers every pending update
 * late, a page boot settles every element late. So the incident rings the bell
 * once (`recordReportIncident`) — 14 `update`s at 14:14:24 on main used to be
 * 14 notifications (2026-10-30). But each op keeps its OWN report
 * (`slow-op:<kind>:<operation>`): filing a burst under one `burst` fingerprint
 * merged unrelated incidents onto one row and left an op that only ever trips
 * beside others with no report of its own. A member of a burst carries `burst`
 * (the batch's count and slowest few), so its report says what tripped with it.
 *
 * Server spans reach the funnel one per batch, so each is its own incident.
 */
export function incidentsFor(
  inputs: readonly RecordSlowOpInput[],
): SlowOpReport[][] {
  const byKind = new Map<string, Map<string, RecordSlowOpInput>>();
  for (const input of inputs) {
    let byOp = byKind.get(input.operationKind);
    if (!byOp) byKind.set(input.operationKind, (byOp = new Map()));
    const seen = byOp.get(input.operation);
    if (!seen || input.ownMs > seen.ownMs) byOp.set(input.operation, input);
  }
  return [...byKind.values()].map((byOp) => {
    const sorted = [...byOp.values()].sort((a, b) => b.ownMs - a.ownMs);
    const burst =
      sorted.length > 1
        ? {
            count: sorted.length,
            operations: sorted.slice(0, BURST_NAMED_CAP).map((i) => ({
              operation: i.operation,
              ownMs: Math.round(i.ownMs),
            })),
          }
        : undefined;
    return sorted.map((input) => ({
      source: input.source,
      data: { ...payloadOf(input), ...(burst && { burst }) },
      message:
        `${input.operationKind} ${input.operation} took ${took(input)}` +
        ` (threshold ${input.thresholdMs}ms)` +
        (burst ? ` — 1 of ${burst.count} at once` : ""),
    }));
  });
}

function payloadOf(input: RecordSlowOpInput): SlowOpReportPayload {
  const { operationKind, operation, durationMs, ownMs, thresholdMs } = input;
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
