import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import type { ConvergenceDecision } from "./decide";

/** The one build a convergence pass runs, or none. */
export interface ConvergenceBuild {
  /** Every app it deploys, main's own first: one `build_runs` row's targets. */
  targets: string[];
  /** The build's `--composition` arguments (empty: a plain build of main's own app). */
  compositionArgs: string[];
  /**
   * Run without the full check pass (`--skip-checks`; the always-run subset
   * and the incremental runtime tsc still run): only for the FIRST deploy of
   * this checkout's own app, when nothing of it is served.
   *
   * The check pass is a gate in front of a deploy: a tree that fails it keeps
   * the served app in place. With nothing served there is nothing for it to
   * keep — it can only turn "an app" into "no app", after the longest step of
   * the whole build (type-check, the layout suite and the Chromium it
   * downloads). And the tree it would check passed it where it was authored
   * (`./equin push` runs it first). On a fresh install that pass sat on the
   * person's critical path for ~20 minutes, holding the machine's only build
   * slot (2026-11-17 Tart VM runs). Every later convergence build, where a
   * served app exists to protect, runs it in full.
   *
   * Ruled out: running the pass after the first deploy in the background (a
   * second, non-gating kind of check run, still contending for the one slot
   * while the person makes their first moves in the app), and running the
   * whole build in the background lane (the slot count, not the lane, is what
   * the first install waits on).
   */
  skipChecks: boolean;
  /**
   * What makes this pass this pass — `(head, targets)`: a pass that would
   * repeat the build it just ran means the ledger lost the attempt.
   */
  key: string;
}

/**
 * Every app the decision wants, built together: ONE build of the decided
 * HEAD — one slot, one `build_runs` row with all targets (main's own app
 * first, then the compositions in manifest order). A decision is of one
 * HEAD, so apps due at different commits are never in one pass: they are
 * successive passes. `null` when nothing is due.
 */
export function convergenceBuild(
  decision: Pick<
    ConvergenceDecision,
    "main" | "compositions" | "head" | "mainServed"
  >,
): ConvergenceBuild | null {
  const targets = [
    ...(decision.main ? [MAIN_COMPOSITION_ID] : []),
    ...decision.compositions,
  ];
  if (targets.length === 0) return null;
  const plain = targets.length === 1 && decision.main;
  return {
    targets,
    compositionArgs: plain ? [] : ["--composition", ...targets],
    skipChecks: decision.main && !decision.mainServed,
    key: `${decision.head ?? "-"} ${targets.join(",")}`,
  };
}
