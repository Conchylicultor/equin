import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import type { ConvergenceDecision } from "./decide";

/** The one build a convergence pass runs, or none. */
export interface ConvergenceBuild {
  /** Every app it deploys, main's own first: one `build_runs` row's targets. */
  targets: string[];
  /** The build's `--composition` arguments (empty: a plain build of main's own app). */
  compositionArgs: string[];
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
  decision: Pick<ConvergenceDecision, "main" | "compositions" | "head">,
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
    key: `${decision.head ?? "-"} ${targets.join(",")}`,
  };
}
