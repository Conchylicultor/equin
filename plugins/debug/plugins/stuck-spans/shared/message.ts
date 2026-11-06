import type { StuckGate, StuckSpanPayload } from "../core";

// Plugin-private wording shared by the server (the report's one-line message and
// its task) and the web (the Debug → Reports summary), so the three say the
// same thing in the same words.

// A coarse, plain-language age: "45 s", "3 min", "1 h 10 min". Minutes are
// floored — the report is filed once, so its age is a lower bound anyway, and
// "3 min" reads better than "3m 07s" in a sentence.
export function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

// "flush flushNotifies → push conversations-gone:count": the open ancestors,
// outermost first, then the stuck span itself. Each step is "<kind> <label>",
// the same spelling the runtime profiler and the trace lanes use.
export function describeChain(
  d: Pick<StuckSpanPayload, "kind" | "label" | "ancestors">,
): string {
  return [...d.ancestors, d]
    .map((step) => `${step.kind} ${step.label}`)
    .join(" → ");
}

// "host-fs.peek {"path":"/tmp"} (1 min), reports.list (12 s)": who held the
// gate, longest first, or a plain statement when it names nobody.
export function describeHolders(gate: Pick<StuckGate, "holders">): string {
  if (gate.holders.length === 0) return "no named holder";
  return gate.holders
    .map((h) => `${h.label} (${formatAge(h.heldMs)})`)
    .join(", ");
}

// "sub reports.list:rows ×80, sub host-fs.peek ×41": the operations queued.
export function describeWaiters(gate: Pick<StuckGate, "waiters">): string {
  return gate.waiters
    .map((w) => `${w.kind} ${w.label}${w.runs > 1 ? ` ×${w.runs}` : ""}`)
    .join(", ");
}

// A gate finding's message: the gate, how long its waiters waited, who held
// it — the waiters are named after it, as what the gate holds up.
function gateMessage(gate: StuckGate, runs: number): string {
  const who = runs > 1 ? `${runs} operations have` : "An operation has";
  return (
    `${who} been queued on the ${gate.layer} gate for up to ` +
    `${formatAge(gate.waitedMs)} without being admitted; it is held by ` +
    `${describeHolders(gate)}. Waiting: ${describeWaiters(gate)}`
  );
}

// The report's one-line message.
export function stuckSpanMessage(
  d: Pick<
    StuckSpanPayload,
    "kind" | "label" | "ageMs" | "ancestors" | "runs" | "gate"
  >,
): string {
  const runs = d.runs ?? 1;
  if (d.gate) return gateMessage(d.gate, runs);
  return runs > 1
    ? `${runs} runs of an operation have been running for up to ` +
        `${formatAge(d.ageMs)} and have not finished: ${describeChain(d)}`
    : `An operation has been running for ${formatAge(d.ageMs)} and has not ` +
        `finished: ${describeChain(d)}`;
}

// The Debug → Reports summary's lead-in, before the chain: "still running after
// 3 min:", or "121 runs still running after 1 min:" for a grouped finding; for
// a gate, "121 waiting on read-admit for 1 min, held by:" before its holders.
export function stuckSpanSummaryLead(
  d: Pick<StuckSpanPayload, "ageMs" | "runs" | "gate">,
): string {
  const runs = d.runs ?? 1;
  if (d.gate)
    return (
      `${runs > 1 ? `${runs} waiting` : "1 waiting"} on ${d.gate.layer} ` +
      `for ${formatAge(d.gate.waitedMs)}, held by:`
    );
  return `${runs > 1 ? `${runs} runs ` : ""}still running after ${formatAge(d.ageMs)}:`;
}
