import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { activeClaudeAccountId } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import { noteClaudeCodeFailure } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import {
  ClaudeTurnError,
  claudeSessionEnv,
  runClaudeTurn,
  type ClaudeQueryInput,
  type ClaudeTurn,
  type ClaudeTurnResult,
} from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import {
  cliFlagFor,
  requireModel,
  type ModelTier,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { callModelTokens, type CallModelTokens } from "./call-tokens";
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

/**
 * The account the call ran on is at a plan usage limit (Claude Code named the
 * turn's failure `rate_limit`). Not a fault: the account's limits say when it
 * resets (runtime-sdk's usage reading), and a background job waits for that
 * instead of failing (`heldAtClaudeLimit`, runtime-sdk/machine). So it is not
 * filed as a crash report — a caller that cannot wait decides what it means.
 */
export class ClaudeUsageLimitError extends ClaudeCliError {
  constructor(
    message: string,
    /** The Claude account whose limit was reached. */
    readonly accountId: string,
  ) {
    super(message);
    this.name = "ClaudeUsageLimitError";
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
 * either way. An error result (max turns), a timeout or a CLI that died throws
 * {@link ClaudeCliError} with Claude Code's own words, filed as a crash report;
 * an account at its usage limit throws {@link ClaudeUsageLimitError}, not
 * filed (the limit is a known state with a known reset, not a fault).
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
  let costUsd: number | null = null;
  let tokens: CallModelTokens[] = [];
  let caughtError: Error | undefined;
  // Resolved once: the account the turn runs on is the one its cost is filed
  // under, even if the active account switches mid-call.
  let accountId: string | null = null;
  try {
    accountId = await activeClaudeAccountId();
    let turn: ClaudeTurn;
    try {
      turn = await runClaudeTurn({
        env: await claudeSessionEnv(accountId),
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
    const { result, apiError } = turn;
    // What the turn cost, at API prices — an error result's too: the tokens
    // it spent were drawn from the account all the same.
    costUsd = result.total_cost_usd;
    // The tokens it used, per model — what the usage ledger files and prices
    // (`total_cost_usd` stays the call log's display value only).
    tokens = callModelTokens(result.modelUsage);
    if (result.subtype !== "success" || result.is_error) {
      const detail =
        result.subtype === "success"
          ? result.result
          : result.errors.join("; ") || result.subtype;
      const message = `Claude Code answered an error (${apiError ?? result.subtype}): ${detail.trim() || "<no output>"}`;
      if (apiError === "rate_limit")
        throw new ClaudeUsageLimitError(message, accountId);
      throw new ClaudeCliError(message);
    }
    output = result.result;
    return answerOf(result);
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    if (caughtError && !(caughtError instanceof ClaudeUsageLimitError)) {
      reportServerError({
        message: `[claude-cli] ${input.source.name}: ${caughtError.message}`,
        ...crashFieldsOf(caughtError),
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
      accountId,
      costUsd,
      tokens,
      at: new Date(),
    });
  }
}
