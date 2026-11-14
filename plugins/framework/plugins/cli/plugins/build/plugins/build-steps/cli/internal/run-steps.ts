import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { buildProfilerStart } from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import type { BuildPhase } from "../../core";
import {
  isBuildStep,
  type AnyBuildStep,
  type BuildPhaseContexts,
  type BuildStep,
} from "./define";

let loaded: Promise<AnyBuildStep[]> | undefined;

function declaredBuildSteps(): Promise<AnyBuildStep[]> {
  return (loaded ??= loadDeclared());
}

async function loadDeclared(): Promise<AnyBuildStep[]> {
  // Loaded at the call, never at module load: stage 1 rewrites the registry
  // inside this very build, and a module Bun already evaluated is frozen
  // (`cli:codegen-manifests-not-frozen`). The first call is after stage 1.
  const { buildStepEntries } = await import("../../core/build-step.generated");
  // Strict: a step that fails to load would otherwise just not run, and the
  // build would report success without it.
  const steps = await loadCollectedDir<AnyBuildStep>(buildStepEntries, {
    isItem: isBuildStep,
    strict: true,
    ordered: true,
    label: "build step",
  });
  const byId = new Map<string, AnyBuildStep>();
  for (const step of steps) {
    const other = byId.get(step.id);
    if (other !== undefined && other !== step) {
      throw new Error(
        `Two build steps are declared with id ${JSON.stringify(step.id)} (owners ${other.owner} and ${step.owner}). ` +
          "The id is the step's profiler span, so it must be unique.",
      );
    }
    byId.set(step.id, step);
  }
  return [...byId.values()];
}

/**
 * Runs every contributed step of `phase`, one after another in registry order
 * (`dependsOn` first), each in its own profiler span. A step that throws fails
 * the build — the error names the step and its owner.
 */
export async function runBuildSteps<P extends BuildPhase>(
  phase: P,
  ctx: BuildPhaseContexts[P],
): Promise<void> {
  const steps = (await declaredBuildSteps()).filter(
    (s): s is AnyBuildStep & BuildStep<P> => s.phase === phase,
  );
  for (const step of steps) {
    const end = buildProfilerStart(step.id, "build:setup", step.label);
    try {
      await step.run(ctx);
    } catch (err) {
      throw new Error(
        `build step ${step.id} (${step.owner}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      end();
    }
  }
}
