import type { StuckSpanPayload } from "../core";

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

// The report's one-line message.
export function stuckSpanMessage(
  d: Pick<StuckSpanPayload, "kind" | "label" | "ageMs" | "ancestors" | "runs">,
): string {
  const runs = d.runs ?? 1;
  return runs > 1
    ? `${runs} runs of an operation have been running for up to ` +
        `${formatAge(d.ageMs)} and have not finished: ${describeChain(d)}`
    : `An operation has been running for ${formatAge(d.ageMs)} and has not ` +
        `finished: ${describeChain(d)}`;
}

// The Debug → Reports summary's lead-in, before the chain: "still running after
// 3 min:", or "121 runs still running after 1 min:" for a grouped finding.
export function stuckSpanSummaryLead(
  d: Pick<StuckSpanPayload, "ageMs" | "runs">,
): string {
  const runs = d.runs ?? 1;
  return `${runs > 1 ? `${runs} runs ` : ""}still running after ${formatAge(d.ageMs)}:`;
}
