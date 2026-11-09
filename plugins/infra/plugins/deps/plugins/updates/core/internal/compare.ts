/**
 * One gate's result: the named suite (`checks`, `tests`, `web build`, or `smoke: <name>`)
 * and the stable identity of every failure in it.
 */
export interface GateResult {
  gate: string;
  failures: string[];
}

/**
 * The failures `after` has that `before` did not, per gate — the candidate
 * toolchain's regressions, before any retry. A failure present on both sides
 * was already there and says nothing about the new versions.
 */
export function newFailures(
  before: readonly GateResult[],
  after: readonly GateResult[],
): GateResult[] {
  const out: GateResult[] = [];
  for (const { gate, failures } of after) {
    const had = new Set(before.find((b) => b.gate === gate)?.failures ?? []);
    const fresh = failures.filter((f) => !had.has(f));
    if (fresh.length > 0) out.push({ gate, failures: fresh });
  }
  return out;
}

/**
 * The regressions that happened AGAIN on a retry: a failure is kept only if the
 * retried gate still has it. A retry that passes is how a flaky failure is told
 * from one the new toolchain caused.
 */
export function confirmedFailures(
  suspected: readonly GateResult[],
  retried: readonly GateResult[],
): GateResult[] {
  const out: GateResult[] = [];
  for (const { gate, failures } of suspected) {
    const still = new Set(retried.find((r) => r.gate === gate)?.failures ?? []);
    const kept = failures.filter((f) => still.has(f));
    if (kept.length > 0) out.push({ gate, failures: kept });
  }
  return out;
}
