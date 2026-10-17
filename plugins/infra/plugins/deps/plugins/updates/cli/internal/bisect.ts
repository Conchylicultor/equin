import type { GateResult } from "../../core/internal/compare";

/** What one probe of a set of units answered: nothing regressed, or what did. */
export type ProbeOutcome =
  { passed: true } | { passed: false; failures: GateResult[] };

/** Where narrowing a regressed set of units ended. */
export interface Narrowed<U> {
  /** Units that passed, together. */
  accepted: U[];
  /** Units that regressed on top of `accepted`, each with what it broke. */
  culprits: { unit: U; regressions: GateResult[] }[];
  /** Units the budget ran out before deciding. */
  untested: U[];
  /** Probes spent. */
  probes: number;
}

/**
 * Narrow a set of units KNOWN to regress together (`failures`) down to the ones
 * responsible, keeping everything else.
 *
 * Keep-the-passing-part bisection: split the set, decide the first half (on top
 * of what is already accepted), then the second (on top of whatever the first
 * contributed). A set that passes is accepted whole; a single unit that fails
 * is a culprit. About `2·k·log2(n/k)` probes for `k` culprits among `n` units;
 * `budget` caps them, and whatever is undecided when it runs out is `untested`.
 *
 * Interactions it does not untangle: a unit that breaks only WITHOUT another
 * is reported as a culprit — the fix is to declare the two as one unit.
 *
 * Pure: the caller's `probe` applies `accepted ∪ subset` and runs the gates;
 * `split` picks the halves (the caller's order of risk).
 */
export async function narrow<U>(args: {
  units: readonly U[];
  failures: GateResult[];
  probe: (units: readonly U[]) => Promise<ProbeOutcome>;
  split: (units: readonly U[]) => [U[], U[]];
  budget: number;
}): Promise<Narrowed<U>> {
  const { probe, split } = args;
  const out: Narrowed<U> = {
    accepted: [],
    culprits: [],
    untested: [],
    probes: 0,
  };

  const search = async (
    set: readonly U[],
    known: GateResult[] | null,
  ): Promise<void> => {
    if (set.length === 0) return;
    let failures = known;
    if (failures === null) {
      if (out.probes >= args.budget) {
        out.untested.push(...set);
        return;
      }
      out.probes++;
      const result = await probe([...out.accepted, ...set]);
      if (result.passed) {
        out.accepted.push(...set);
        return;
      }
      failures = result.failures;
    }
    if (set.length === 1) {
      out.culprits.push({ unit: set[0]!, regressions: failures });
      return;
    }
    const [a, b] = split(set);
    if (a.length === 0 || b.length === 0)
      throw new Error("split must divide a set of two or more units in two.");
    await search(a, null);
    await search(b, null);
  };

  await search(args.units, args.failures);
  return out;
}

/**
 * A `split` for {@link narrow}: low-risk units (`risky` false) apart from risky
 * ones while a set mixes both — most of a batch is patch and minor releases
 * that pass together in one probe — then halves, in order.
 */
export function riskFirstSplit<U>(
  risky: (u: U) => boolean,
): (units: readonly U[]) => [U[], U[]] {
  return (units) => {
    const safe = units.filter((u) => !risky(u));
    const rest = units.filter((u) => risky(u));
    if (safe.length > 0 && rest.length > 0) return [safe, rest];
    const mid = Math.ceil(units.length / 2);
    return [units.slice(0, mid), units.slice(mid)];
  };
}

/**
 * Whether moving `from` → `to` crosses a breaking line, by semver's reading:
 * the major differs, or both are `0.x` and the minor differs. Anything that does
 * not parse as leading numbers, or an input added fresh, counts as risky.
 */
export function isBreakingMove(from: string | null, to: string): boolean {
  if (from === null) return true;
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)(?:\.(\d+))?/.exec(v);
    return m === null ? null : [Number(m[1]), Number(m[2] ?? 0)];
  };
  const a = parse(from);
  const b = parse(to);
  if (a === null || b === null) return true;
  if (a[0] !== b[0]) return true;
  return a[0] === 0 && a[1] !== b[1];
}
