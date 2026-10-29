import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { activeClaudeAccountId } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import { noteClaudeCodeFailure } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import {
  ClaudeTurnError,
  claudeSessionEnv,
  runClaudeTurn,
  type ClaudeQueryInput,
  type ClaudeTurnResult,
} from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import {
  cliFlagFor,
  requireModel,
  type ModelTier,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { recordClaudeCliCall } from "./record-call";

// A one-shot generation is one Agent SDK turn (infra/claude-cli/sdk) on the
// ACTIVE Claude account — the one new agents launch on — under the host facts
// alone (`claudeSessionEnv`'s default base), never this process's environment.
// It used to spawn `claude --print` by hand with no account at all, so it
// always ran on the computer's own login: a switched account never reached a
// task title, and a full system account failed every background generation.

export interface RunClaudePrintInput {
  tier: ModelTier;
  prompt: string;
  system?: string;
  timeoutMs?: number;
  // Identifies the caller for the debug call log. Required so every entry in
  // the pane has a meaningful "what launched this" label.
  source: {
    name: string;
    context?: Record<string, unknown>;
    /**
     * The domain record this call is being made FOR, so a feature plugin can
     * later ask "which model calls produced this record?" (the `claudeCliCallsFor` value, `claude-cli.calls-for`).
     *
     * MUST be a globally unique row id — a UUID / DB row id. The column is NOT
     * namespaced by `source.name`, so a per-caller ordinal ("run-3") would collide
     * across callers and serve one plugin another's prompts. Put human-readable
     * ids in `context` instead; that is the label, this is the key.
     */
    correlationId?: string;
  };
}

export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export async function runClaudePrint(
  input: RunClaudePrintInput,
): Promise<string> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  // A family always resolves (to its current version in the live catalog).
  const resolvedModel = requireModel(input.tier, getModelCatalog());
  // `tools: []` disables every tool so the model can't go off and plan/edit;
  // `systemPrompt` replaces (not appends) the default system prompt so the
  // project's CLAUDE.md context doesn't leak in and bias output away from the
  // requested format; `persistSession: false` avoids polluting the user's
  // resume list with throwaway one-shot calls. `cwd: "/tmp"` so claude doesn't
  // auto-discover project CLAUDE.md files (defensive — the system prompt
  // replacement should already cover this).
  const result = await invokeClaude({
    options: {
      cwd: "/tmp",
      tools: [],
      ...(input.system ? { systemPrompt: input.system } : {}),
    },
    input,
    timeoutMs,
    resolvedModel,
    answerOf: (r) => r.result,
  });
  return result;
}

/**
 * Run `input.prompt` as one turn with `options` on the active account and
 * return `answerOf` its successful result — recording the call in the log
 * either way. An error result (a usage limit, max turns), a timeout or a CLI
 * that died throws {@link ClaudeCliError} with Claude Code's own words.
 */
export async function invokeClaude<T>({
  options,
  input,
  timeoutMs,
  resolvedModel,
  answerOf,
}: {
  options: ClaudeQueryInput["options"];
  input: RunClaudePrintInput;
  timeoutMs: number;
  resolvedModel: ReturnType<typeof requireModel>;
  answerOf: (result: Extract<ClaudeTurnResult, { subtype: "success" }>) => T;
}): Promise<T> {
  const startedAt = performance.now();
  let output: string | undefined;
  let caughtError: Error | undefined;
  try {
    let result: ClaudeTurnResult;
    try {
      result = await runClaudeTurn({
        env: await claudeSessionEnv(activeClaudeAccountId()),
        prompt: input.prompt,
        options: {
          // What `claude --print` loaded: the user's own settings and env
          // overrides, so a generation runs as their Claude Code does (a
          // caller may narrow it).
          settingSources: ["user"],
          ...options,
          model: cliFlagFor(resolvedModel),
          persistSession: false,
        },
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof ClaudeTurnError) {
        // A timeout is a different fact from a refusal ("the model took too
        // long" vs "the CLI refused") and only one is worth retrying with the
        // same prompt; a CLI that died may be Claude Code itself.
        if (!err.timedOut) noteClaudeCodeFailure();
        throw new ClaudeCliError(err.message);
      }
      // The SDK's own failures — "Claude Code process exited with code N" —
      // may be Claude Code itself (signed out since the last check), so the
      // status the app shows is re-checked against this evidence.
      noteClaudeCodeFailure();
      throw new ClaudeCliError(
        err instanceof Error ? err.message : String(err),
      );
    }
    if (result.subtype !== "success" || result.is_error) {
      const detail =
        result.subtype === "success"
          ? result.result
          : result.errors.join("; ") || result.subtype;
      throw new ClaudeCliError(
        `Claude Code answered an error (${result.subtype}): ${detail.trim() || "<no output>"}`,
      );
    }
    output = result.result;
    return answerOf(result);
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    if (caughtError) {
      reportServerError({
        message: `[claude-cli] ${input.source.name}: ${caughtError.message}`,
        stack: caughtError.stack,
        errorType: caughtError.name,
      });
    }
    // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- observability write: records a claude-cli call log; must stay profiler-invisible
    void recordClaudeCliCall({
      model: resolvedModel,
      sourceName: input.source.name,
      sourceContext: input.source.context ?? null,
      prompt: input.prompt,
      system: input.system ?? null,
      output: output ?? null,
      error: caughtError ? caughtError.message : null,
      durationMs,
      correlationId: input.source.correlationId ?? null,
    });
  }
}
