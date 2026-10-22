import type { WorkspaceSpec } from "../../core";
import { ScratchProfile } from "./scratch-profile";

/**
 * Validates (and normalizes) a NEW attempt's workspace spec, before anything
 * is written: an unknown scratch profile, or an input its profile refuses,
 * throws here. What it returns is what the attempt row stores.
 *
 * Pure over the in-process scratch-profile registry, so it runs on every host —
 * a task's workspace is set (and refused) where the task is filed, which needs
 * no computer; only launching in it does.
 */
export function parseWorkspaceSpec(spec: WorkspaceSpec): WorkspaceSpec {
  switch (spec.kind) {
    // A worktree is fully described by its kind.
    case "worktree":
      return spec;
    case "scratch": {
      const profile = ScratchProfile.get(spec.profile);
      return {
        kind: "scratch",
        profile: spec.profile,
        input: profile.inputSchema.parse(spec.input),
      };
    }
  }
}
