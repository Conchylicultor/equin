import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import type { BuildPhase } from "../../core";

/** What the build hands a step, per phase. */
export interface BuildPhaseContexts {
  dependencies: {
    /** The checkout being built. */
    root: string;
    /** The build's console sink. */
    log: (line: string) => void;
  };
  deployed: {
    root: string;
    log: (line: string) => void;
    /** The namespace the checkout's own app was just deployed at. */
    namespace: Namespace;
  };
}

/** One step a plugin contributes to `./equin build`. */
export interface BuildStep<P extends BuildPhase = BuildPhase> {
  readonly _brand: "BuildStep";
  /** The step's profiler span id — stable across builds, so its timing
   *  baseline (`build/step-baseline`) carries over. Unique across steps. */
  readonly id: string;
  /** The contributing plugin, for error messages. */
  readonly owner: string;
  /** What the step does, as the build profile shows it. */
  readonly label: string;
  readonly phase: P;
  readonly run: (ctx: BuildPhaseContexts[P]) => Promise<void>;
}

type AnyBuildStep = { [P in BuildPhase]: BuildStep<P> }[BuildPhase];

export function defineBuildStep<P extends BuildPhase>(
  step: Omit<BuildStep<P>, "_brand">,
): BuildStep<P> {
  return { ...step, _brand: "BuildStep" };
}

export function isBuildStep(value: unknown): value is AnyBuildStep {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _brand?: unknown })._brand === "BuildStep"
  );
}

export type { AnyBuildStep };
