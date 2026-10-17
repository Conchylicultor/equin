import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  confirmedFailures,
  newFailures,
  type GateResult,
} from "../../core/internal/compare";
import {
  isBreakingMove,
  narrow,
  riskFirstSplit,
  type ProbeOutcome,
} from "./bisect";
import type { Gates } from "./gates";
import type { Move, Updater, UpdaterSmoke } from "../../core/internal/updater";
import {
  describeHold,
  reviewableHolds,
  type Hold,
} from "../../core/internal/hold";

/**
 * `running` until the end, and only then: every run ends on one of the others.
 * `current`: nothing newer to move to. `upgraded`: every planned move landed and
 * nothing regressed. `partial`: some moves landed (proven together); the rest
 * regressed (`culprits`) or were never decided (`untested`). `regressed`:
 * nothing landed — the files were put back. `aborted`: the run itself failed
 * before a verdict (`error`) — the files were put back. `holds-to-review`: a
 * hold is past its `reviewBy` (`holdsToReview`) — nothing was planned or
 * touched; lift or renew each, then run again.
 */
export type UpgradeVerdict =
  | "running"
  | "current"
  | "upgraded"
  | "partial"
  | "regressed"
  | "aborted"
  | "holds-to-review";

/** A hold past its `reviewBy`, with the updater and file it belongs to. */
export interface HoldToReview {
  updater: string;
  file: string;
  hold: Hold;
}

/** One updater a run moves, restricted to `only` (names it knows) when given. */
export interface UpgradeSelection {
  updater: Updater;
  only?: readonly string[];
}

/** A move, with the updater that makes it. */
export interface UpdaterMove extends Move {
  updater: string;
}

/** Moves that regressed together, and what they broke. */
export interface UpgradeCulprit {
  moves: UpdaterMove[];
  regressions: GateResult[];
}

/** One gate run over a set of units: the full suites, or only the targeted failures. */
export interface UpgradeProbe {
  kind: "full" | "targeted";
  units: string[];
  passed: boolean;
  failures: GateResult[];
}

/**
 * `deps-upgrade-<updater>.json` (one updater) or `deps-upgrade.json` (every
 * updater at once): what this run moved and what it proved.
 */
export interface UpgradeReceipt {
  updaters: string[];
  pid: number;
  startedAt: string;
  finishedAt: string | null;
  verdict: UpgradeVerdict;
  /** Why the run aborted (`aborted` only). */
  error: string | null;
  /** Holds past their `reviewBy` (`holds-to-review` only): the work before any upgrade. */
  holdsToReview: HoldToReview[];
  /** What each updater's `prepare` recorded (mise: its own version before and after), by updater id. */
  notes: Record<string, Record<string, string>>;
  /** Every move planned. */
  moves: UpdaterMove[];
  baseline: GateResult[] | null;
  /**
   * The baseline's failures: what already fails on the current releases, and so
   * could not catch a regression. Not the upgrade's to fix — file it.
   */
  blind: GateResult[] | null;
  /** The full gates over every planned move. */
  candidate: GateResult[] | null;
  /** The candidate's failures the baseline did not have, confirmed by a retry. */
  regressions: GateResult[] | null;
  /** The moves in the files now, proven together by the full gates. */
  landed: UpdaterMove[];
  culprits: UpgradeCulprit[];
  untested: UpdaterMove[];
  probes: UpgradeProbe[];
}

/** Targeted probes a run may spend narrowing regressions down. */
export const MAX_PROBES = 40;
/** Full-gate proofs of a narrowed set before giving up on landing any of it. */
export const MAX_ROUNDS = 3;

function writeReceipt(path: string, receipt: UpgradeReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n");
  renameSync(tmp, path);
}

export function formatMove(m: UpdaterMove): string {
  return m.from === null
    ? `${m.updater} ${m.name} (new) → ${m.to}`
    : `${m.updater} ${m.name} ${m.from} → ${m.to}`;
}

function printGates(
  log: (line: string) => void,
  title: string,
  results: readonly GateResult[],
): void {
  log(`\n${title}`);
  for (const { gate, failures } of results) {
    log(
      `  ${gate}: ${failures.length === 0 ? "ok" : `${failures.length} failing`}`,
    );
    for (const f of failures.slice(0, 20)) log(`    • ${f}`);
    if (failures.length > 20) log(`    … ${failures.length - 20} more`);
  }
}

/** The files an updater may rewrite, as they are now (`null`: absent). */
function snapshot(
  root: string,
  files: readonly string[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const rel of files) {
    const path = join(root, rel);
    out.set(rel, existsSync(path) ? readFileSync(path, "utf8") : null);
  }
  return out;
}

function restore(
  root: string,
  saved: ReadonlyMap<string, string | null>,
): void {
  for (const [rel, content] of saved) {
    const path = join(root, rel);
    if (content === null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
}

/** Moves that land together: one lockstep unit of one updater. */
interface Unit {
  key: string;
  moves: UpdaterMove[];
}

function unitsOf(moves: readonly UpdaterMove[]): Unit[] {
  const units = new Map<string, Unit>();
  for (const m of moves) {
    const key = `${m.updater}:${m.unit ?? m.name}`;
    const unit = units.get(key) ?? { key, moves: [] };
    unit.moves.push(m);
    units.set(key, unit);
  }
  return [...units.values()];
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
}

/**
 * One upgrade, the gated way, over one or several updaters at once:
 *
 * 1. Each updater's `prepare` (mise updates itself), then `plan` the moves.
 *    None anywhere → `current`.
 * 2. BASELINE — every gate on the current inputs, so a failure the repo already
 *    has is not blamed on the new ones (and is recorded as `blind`).
 * 3. CANDIDATE — snapshot every updater's files, `apply` every move, the same
 *    gates. A failure only the candidate has is retried; one that fails AGAIN
 *    is a regression. An `apply` that throws is a regression too (its own
 *    tooling crashing on the new release is the plainest kind). None →
 *    `upgraded`.
 * 4. NARROW — the moves are split into units (a lockstep group never splits)
 *    and bisected: each probe applies a subset and re-runs only the confirmed
 *    regressions (`gates.retry`), so it costs minutes, not the suites. Units
 *    that pass are kept; one that fails alone is a culprit.
 * 5. PROVE — the kept units get the full gates again; a regression only the
 *    full run sees narrows again (at most {@link MAX_ROUNDS} proofs). Proven
 *    and something left out → `partial`; nothing kept → `regressed`.
 *
 * Every exit but `upgraded`/`partial` puts the files back AND runs each
 * updater's `sync`, so the worktree's installs match its files again. Anything
 * that throws ends as `aborted` with the error on the receipt — the receipt is
 * never left `running`.
 *
 * Pure of process state: the caller resolves the checkout, the receipt path and
 * the gates (the real ones spawn `./singularity check` / `test`).
 */
export async function runUpgrade(args: {
  selection: readonly UpgradeSelection[];
  root: string;
  receiptPath: string;
  gates: Gates;
  log: (line: string) => void;
}): Promise<UpgradeReceipt> {
  const { selection, receiptPath, log } = args;
  if (selection.length === 0) throw new Error("No updater to run.");
  const receipt: UpgradeReceipt = {
    updaters: selection.map((s) => s.updater.id),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    verdict: "running",
    error: null,
    holdsToReview: [],
    notes: {},
    moves: [],
    baseline: null,
    blind: null,
    candidate: null,
    regressions: null,
    landed: [],
    culprits: [],
    untested: [],
    probes: [],
  };
  writeReceipt(receiptPath, receipt);
  log(`Receipt: ${receiptPath}`);

  // Set once the files are snapshotted: from then on, any exit that is not a
  // landing puts them back.
  const onAbort: { putBack: (() => Promise<void>) | null } = { putBack: null };
  try {
    await upgrade({
      ...args,
      receipt,
      onSnapshot: (f) => {
        onAbort.putBack = f;
      },
    });
  } catch (err) {
    receipt.verdict = "aborted";
    receipt.error =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`\nABORTED: ${firstLine(err)}`);
    if (onAbort.putBack !== null) {
      try {
        await onAbort.putBack();
      } catch (restoreErr) {
        receipt.error +=
          `\n\nPutting the files back failed too — the files may be back but not the installs ` +
          `(run \`bun install\`): ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
      }
    }
  }
  receipt.finishedAt = new Date().toISOString();
  writeReceipt(receiptPath, receipt);
  return receipt;
}

async function upgrade(args: {
  selection: readonly UpgradeSelection[];
  root: string;
  receiptPath: string;
  gates: Gates;
  log: (line: string) => void;
  receipt: UpgradeReceipt;
  onSnapshot: (putBack: () => Promise<void>) => void;
}): Promise<void> {
  const { selection, root, receiptPath, gates, log, receipt } = args;
  const save = () => writeReceipt(receiptPath, receipt);

  // Every hold is reviewed before anything moves: a lapsed one stops the run
  // here, before any updater prepares (mise updates itself) or plans.
  const now = new Date();
  for (const { updater } of selection)
    for (const hold of await reviewableHolds(updater, root, now))
      receipt.holdsToReview.push({
        updater: updater.id,
        file: updater.holds.file,
        hold,
      });
  if (receipt.holdsToReview.length > 0) {
    receipt.verdict = "holds-to-review";
    log(
      "\nHOLDS TO REVIEW — nothing planned. Lift or renew each, then run again:",
    );
    for (const h of receipt.holdsToReview)
      log(`  ${h.updater} (${h.file}): ${describeHold(h.hold)}`);
    return;
  }

  // Every updater's moves, planned before any gate runs.
  const planned: Updater[] = [];
  for (const { updater, only } of selection) {
    if (updater.prepare !== undefined) {
      receipt.notes[updater.id] = { ...(await updater.prepare(root, log)) };
      save();
    }
    const moves = await updater.plan(root, only);
    if (moves.length === 0) {
      log(`${updater.id}: everything is on its latest release.`);
      continue;
    }
    planned.push(updater);
    receipt.moves.push(...moves.map((m) => ({ updater: updater.id, ...m })));
  }
  if (planned.length === 0) {
    receipt.verdict = "current";
    log("\nEverything is on its latest release. Nothing to prove.");
    return;
  }
  save();
  for (const m of receipt.moves) log(`  ${formatMove(m)}`);

  const smoke: UpdaterSmoke[] = [];
  for (const updater of planned)
    smoke.push(
      ...(await updater.smoke(
        root,
        receipt.moves.filter((m) => m.updater === updater.id),
      )),
    );
  const dup = smoke.find(
    (s, i) => smoke.findIndex((t) => t.name === s.name) !== i,
  );
  if (dup !== undefined) {
    // A smoke test's name is its identity, before and after the move.
    throw new Error(`Two smoke tests are named "${dup.name}".`);
  }

  log("\n── Baseline: current releases ──");
  const baseline = await gates.all(smoke);
  receipt.baseline = baseline;
  receipt.blind = baseline.filter((g) => g.failures.length > 0);
  save();

  const files: string[] = [];
  for (const updater of planned) files.push(...(await updater.files(root)));
  const saved = snapshot(root, [...new Set(files)]);
  const putBack = async (): Promise<void> => {
    restore(root, saved);
    for (const updater of planned) await updater.sync(root, log);
    log(`\n${[...saved.keys()].join(", ")} put back.`);
  };
  args.onSnapshot(putBack);

  /** Put the files back, then apply exactly `units`. A throw is the failure. */
  const applyUnits = async (
    units: readonly Unit[],
  ): Promise<GateResult | null> => {
    restore(root, saved);
    const moves = units.flatMap((u) => u.moves);
    try {
      for (const updater of planned) {
        const mine = moves.filter((m) => m.updater === updater.id);
        if (mine.length > 0) await updater.apply(root, mine, log);
      }
      return null;
    } catch (err) {
      log(`  apply failed: ${firstLine(err)}`);
      return { gate: "apply", failures: [`apply: ${firstLine(err)}`] };
    }
  };

  /** The full gates over `units`: the confirmed regressions against the baseline. */
  const full = async (units: readonly Unit[]): Promise<GateResult[]> => {
    log(`\n── Candidate: ${units.length} unit(s) ──`);
    const crashed = await applyUnits(units);
    let confirmed: GateResult[];
    if (crashed !== null) {
      confirmed = [crashed];
    } else {
      const results = await gates.all(smoke);
      if (receipt.candidate === null) receipt.candidate = results;
      const suspected = newFailures(baseline, results);
      confirmed =
        suspected.length === 0
          ? []
          : confirmedFailures(suspected, await gates.retry(smoke, suspected));
    }
    receipt.probes.push({
      kind: "full",
      units: units.map((u) => u.key),
      passed: confirmed.length === 0,
      failures: confirmed,
    });
    save();
    return confirmed;
  };

  /** Only `targets`, over `units`: retried once before a failure counts. */
  const targeted =
    (targets: readonly GateResult[]) =>
    async (units: readonly Unit[]): Promise<ProbeOutcome> => {
      log(`\n── Probe: ${units.length} unit(s) ──`);
      const crashed = await applyUnits(units);
      let failures: GateResult[];
      if (crashed !== null) {
        failures = [crashed];
      } else {
        const rest = targets.filter((t) => t.gate !== "apply");
        failures =
          rest.length === 0
            ? []
            : confirmedFailures(rest, await gates.retry(smoke, rest));
        if (failures.length > 0)
          failures = confirmedFailures(
            failures,
            await gates.retry(smoke, failures),
          );
      }
      receipt.probes.push({
        kind: "targeted",
        units: units.map((u) => u.key),
        passed: failures.length === 0,
        failures,
      });
      save();
      return failures.length === 0
        ? { passed: true }
        : { passed: false, failures };
    };

  const all = unitsOf(receipt.moves);
  let regressions = await full(all);
  receipt.regressions = regressions;
  save();

  let kept: Unit[] = all;
  let probes = 0;
  const split = riskFirstSplit<Unit>((u) =>
    u.moves.some((m) => isBreakingMove(m.from, m.to)),
  );
  for (let round = 1; regressions.length > 0; round++) {
    printGates(
      log,
      "REGRESSIONS (fail only on the new releases, twice):",
      regressions,
    );
    if (round > MAX_ROUNDS) {
      log(`\nStill regressing after ${MAX_ROUNDS} proofs: nothing lands.`);
      receipt.untested.push(...kept.flatMap((u) => u.moves));
      kept = [];
      break;
    }
    log(`\n── Narrowing ${kept.length} unit(s) down (round ${round}) ──`);
    const narrowed = await narrow({
      units: kept,
      failures: regressions,
      probe: targeted(regressions),
      split,
      budget: MAX_PROBES - probes,
    });
    probes += narrowed.probes;
    for (const { unit, regressions: r } of narrowed.culprits)
      receipt.culprits.push({ moves: unit.moves, regressions: r });
    receipt.untested.push(...narrowed.untested.flatMap((u) => u.moves));
    kept = narrowed.accepted;
    save();
    if (kept.length === 0) break;
    regressions = await full(kept);
  }

  printGates(log, "Baseline (current releases):", baseline);
  if (receipt.candidate !== null)
    printGates(log, "Candidate (every new release):", receipt.candidate);
  if (receipt.blind !== null && receipt.blind.length > 0) {
    const n = receipt.blind.reduce((a, g) => a + g.failures.length, 0);
    log(
      `\n${n} failure(s) already on the baseline: those could not catch a regression. ` +
        "File them (add_task); they are not this upgrade's to fix.",
    );
  }
  for (const c of receipt.culprits)
    log(
      `\nCULPRIT ${c.moves.map(formatMove).join(", ")}: ` +
        c.regressions
          .flatMap((g) => g.failures)
          .slice(0, 5)
          .join("; "),
    );
  if (receipt.untested.length > 0)
    log(
      `\nUNTESTED (budget ran out; the next upgrade retries them): ${receipt.untested.map(formatMove).join(", ")}`,
    );

  if (kept.length === 0) {
    await putBack();
    receipt.verdict = "regressed";
    log(
      "\nREGRESSED: nothing landed. Fix or hold each culprit (the receipt names them), then upgrade again.",
    );
    return;
  }
  // The tree holds exactly `kept`: the last full run applied it and passed.
  receipt.landed = kept.flatMap((u) => u.moves);
  receipt.verdict = kept.length === all.length ? "upgraded" : "partial";
  log(
    `\n${receipt.verdict.toUpperCase()}: ${receipt.landed.map(formatMove).join(", ")}. ` +
      `No regression against the current releases. ${[...saved.keys()].join(", ")} updated — commit it.`,
  );
}
