import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * A scratch workspace's profile: everything a scratch agent gets, since it
 * carries none of this repo's context. Contributed by a feature plugin
 * (`register: [ScratchProfile.define(defineScratchProfile({ … }))]`); the
 * attempt stores only `{ profile: id, input }`, so improving a profile applies
 * to the next launch.
 */
export interface ScratchProfileDef<I> {
  /** Unique, e.g. `sonata.transcription`. */
  id: string;
  description: string;
  /** Validates the launch's `input` when the attempt is created. */
  inputSchema: ZodParser<I>;
  /** The agent's whole project context: written to `<dir>/CLAUDE.md`. */
  instructions: (input: I) => string;
  /**
   * The MCP tools the agent sees — exactly these (a tool declaring `profiles`
   * is visible only to the profiles it names).
   */
  mcpTools: readonly string[];
  /** Merged into the launch's `--settings` as `permissions`. */
  permissions?: { allow?: readonly string[]; deny?: readonly string[] };
  /**
   * Runs in the spawn job after `CLAUDE.md` is written, before the session
   * starts: materialize inputs, ensure deps, write `<dir>/bin/` wrappers.
   * Must be idempotent (a retried spawn runs it again).
   */
  prepare?: (at: {
    dir: string;
    attemptId: string;
    input: I;
    signal: AbortSignal;
  }) => Promise<void>;
}

/** Declares a profile, inferring its input type from `inputSchema`. */
export function defineScratchProfile<I>(
  profile: ScratchProfileDef<I>,
): ScratchProfileDef<I> {
  return profile;
}

const profiles = new Map<string, ScratchProfileDef<unknown>>();

export const ScratchProfile = {
  /**
   * Returns a {@link Registration} token, like `Workspace.define`: the
   * duplicate-id guard fires at the plugin register phase.
   */
  define<I>(profile: ScratchProfileDef<I>): Registration {
    return {
      register() {
        if (profiles.has(profile.id)) {
          throw new Error(`Scratch profile "${profile.id}" already registered`);
        }
        profiles.set(profile.id, profile as ScratchProfileDef<unknown>);
      },
    };
  },
  get(id: string): ScratchProfileDef<unknown> {
    const profile = profiles.get(id);
    if (!profile) throw new Error(`Unknown scratch profile "${id}"`);
    return profile;
  },
  all(): ScratchProfileDef<unknown>[] {
    return Array.from(profiles.values());
  },
};

/** Clears the profile registry (tests). */
export function resetScratchProfiles(): void {
  profiles.clear();
}
