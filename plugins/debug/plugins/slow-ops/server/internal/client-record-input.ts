import type { SlowOpClientItem } from "../../shared/endpoints";
import type { RecordSlowOpInput } from "./input";

/**
 * One client item → the funnel's input. Pure: the measurement, caller, waits
 * and variant pass straight through; the trace (captured per kind, see
 * `toRecordInputs`) is linked by id. `clientBoot` never reaches the recorder —
 * it rides only the trace trigger, keeping the aggregate row lean.
 */
export function toRecordInput(
  item: SlowOpClientItem,
  traceId: string | undefined,
): RecordSlowOpInput {
  return {
    operationKind: item.operationKind,
    operation: item.operation,
    durationMs: item.durationMs,
    thresholdMs: item.thresholdMs,
    source: "client-slow-op",
    caller: item.caller ?? null,
    waits: item.waits,
    detail: item.detail,
    transportColdStart: item.transportColdStart,
    traceId,
  };
}

/**
 * A batch's items → funnel inputs, with ONE trace per operationKind.
 *
 * A live stall arrives as a burst — one `update` per resource the stalled
 * change touched, every tab — and a trace per item would spend the trace
 * engine's global per-minute budget on one incident, starving every other
 * trigger. The server window at receipt is the same evidence for every item of
 * a batch anyway, so the slowest item of each kind stands for its kind (its
 * label and duration name the trace) and every item of that kind links to it.
 *
 * `capture` is handed the representative item and how many items it stands for;
 * it returns the trace id, or undefined when the engine did not admit one.
 */
export function toRecordInputs(
  items: readonly SlowOpClientItem[],
  capture: (item: SlowOpClientItem, batchCount: number) => string | undefined,
): RecordSlowOpInput[] {
  const byKind = new Map<string, SlowOpClientItem[]>();
  for (const item of items) {
    const group = byKind.get(item.operationKind);
    if (group) group.push(item);
    else byKind.set(item.operationKind, [item]);
  }
  const traceByKind = new Map<string, string | undefined>();
  for (const [kind, group] of byKind) {
    const slowest = group.reduce((a, b) =>
      b.durationMs > a.durationMs ? b : a,
    );
    traceByKind.set(kind, capture(slowest, group.length));
  }
  return items.map((item) =>
    toRecordInput(item, traceByKind.get(item.operationKind)),
  );
}
