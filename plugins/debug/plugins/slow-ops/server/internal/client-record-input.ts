import { SLEEP_LAYER, type SlowOpClientItem } from "../../shared/endpoints";
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
    // An older tab's item carries no own time: all of it counts.
    ownMs: item.ownMs ?? item.durationMs,
    thresholdMs: item.thresholdMs,
    source: "client-slow-op",
    caller: item.caller ?? null,
    waits: item.waits,
    detail: item.detail,
    transportColdStart: item.transportColdStart,
    traceId,
    // A signal filed after the fact names when it ended; never later than now
    // (a skewed client clock must not stamp a sample into the future).
    ...(item.endedAt !== undefined
      ? { occurredAt: new Date(Math.min(item.endedAt, Date.now())) }
      : {}),
  };
}

/**
 * Take the machine's sleep off a client item: a browser times on the wall
 * clock, which runs through a nap. The window is the item's last `durationMs`
 * before its `endedAt` (stamped by the queue on every windowed item); the
 * overlap is charged to the `sleep` layer and off its own time → the item, or
 * null when it is no longer over its bar. `sleptMs` null (cannot tell) or 0
 * leaves it unchanged; so does an item with no `endedAt`.
 */
export function withoutSleep(
  item: SlowOpClientItem,
  sleptMs: (startMs: number, endMs: number) => number | null,
): SlowOpClientItem | null {
  if (item.endedAt === undefined) return item;
  const slept = sleptMs(item.endedAt - item.durationMs, item.endedAt);
  if (slept === null || slept <= 0) return item;
  const ownMs = Math.max(
    0,
    (item.ownMs ?? item.durationMs) - Math.round(slept),
  );
  if (ownMs <= item.thresholdMs) return null;
  return {
    ...item,
    ownMs,
    waits: { ...item.waits, [SLEEP_LAYER]: Math.round(slept) },
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
