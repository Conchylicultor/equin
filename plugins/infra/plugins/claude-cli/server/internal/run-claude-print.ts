import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { pickHostEnv } from "@plugins/infra/plugins/launcher/core";
import {
  ClaudeCodeUnavailableError,
  noteClaudeCodeFailure,
  requireClaudeBin,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  cliFlagFor,
  requireModel,
  type ModelTier,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { recordClaudeCliCall } from "./record-call";

// A one-shot `claude --print` starts from the host facts alone (HOME, USER,
// PATH, locale — `pickHostEnv`), never from this process's environment.
//
// It used to copy that environment minus every CLAUDE_CODE_* name, because a
// backend started from an agent shell carried the shell's Claude session
// variables, and one of them (CLAUDE_CODE_EXTRA_BODY with adaptive thinking)
// broke Haiku calls outright. A denylist only catches the names somebody
// already noticed, and what a process may have inherited is an open set — so
// the list is closed instead. It is also right whatever the backend was
// started with, including by a gateway that predates the declared runtime
// environment. Agent panes run `claude` the same way (`env -i` over a closed
// list, runtime-tmux's agent-session-env.ts), which is the evidence that
// its login and keychain access need nothing beyond these.
const claudeEnv = pickHostEnv(process.env);

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
  const cliFlag = cliFlagFor(resolvedModel);
  // `--tools ""` disables every tool so the model can't go off and plan/edit;
  // `--system-prompt` replaces (not appends) the default system prompt so the
  // project's CLAUDE.md context doesn't leak in and bias output away from the
  // requested format; `--no-session-persistence` avoids polluting the user's
  // resume list with throwaway one-shot calls.
  const args = [
    "--print",
    "--model",
    cliFlag,
    "--tools",
    "",
    "--no-session-persistence",
  ];
  if (input.system) args.push("--system-prompt", input.system);
  return invokeClaude({ args, cwd: "/tmp", input, timeoutMs, resolvedModel });
}

/**
 * Spawn `claude` with `args` once, feeding `input.prompt` on stdin, and return
 * its stdout — recording the call in the log either way.
 */
export async function invokeClaude({
  args,
  cwd,
  input,
  timeoutMs,
  resolvedModel,
}: {
  args: readonly string[];
  cwd: string;
  input: RunClaudePrintInput;
  timeoutMs: number;
  resolvedModel: ReturnType<typeof requireModel>;
}): Promise<string> {
  const startedAt = performance.now();
  let output: string | undefined;
  let caughtError: Error | undefined;
  try {
    // `spawnCaptured`, NOT a raw `Bun.spawn` with piped stdio — and this is a
    // correctness requirement, not a style preference.
    //
    // What this used to be: `Bun.spawn({ stdout: "pipe", stderr: "pipe" })` plus
    // `Promise.all([new Response(proc.stdout).text(), …, proc.exited])`, with a
    // `setTimeout(() => proc.kill(), timeoutMs)` as the only ceiling. That shape
    // hits bun 1.3.13's exit-during-stream-pull race: when the child exits while
    // a JS stream pull is pending, the pull promise NEVER settles. Observed in a
    // live backend on 2026-08-08 — an `events.refresh-source` job parked for over
    // two hours with the child long gone, no `claude_cli_calls` row (the row is
    // written in the `finally` below, which never ran), and nothing on screen but
    // a source stuck on "running". The `proc.kill()` cannot rescue it: the child
    // is already dead, so there is nothing left to signal.
    //
    // `spawnCaptured` redirects the child's stdio to temp-file fds — a kernel
    // dup2, with no JS stream in either direction — and delivers stdin as a whole
    // buffer the same way, so the race has nothing to wedge. `timeoutMs` becomes a
    // REAL ceiling (SIGTERM, then SIGKILL) reported as `timedOut` on the result
    // rather than inferred from a signal anyone could have sent.
    //
    // `cwd: "/tmp"` for a plain print so claude doesn't auto-discover project
    // CLAUDE.md files even with --system-prompt set (defensive — the system
    // prompt replacement should already cover this).
    const result = await spawnCaptured([requireClaudeBin(), ...args], {
      cwd,
      env: claudeEnv,
      stdin: input.prompt,
      timeoutMs,
    });

    if (result.timedOut) {
      // Distinct from a non-zero exit on purpose: "the model took too long" is a
      // different fact from "the CLI refused", and only one of them is worth
      // retrying with the same prompt.
      throw new ClaudeCliError(
        `claude --print did not finish within ${timeoutMs}ms and was killed.`,
      );
    }
    if (result.exitCode !== 0) {
      // A refusal can be Claude Code itself (signed out since the last check),
      // so the status the app shows is re-checked against this evidence.
      noteClaudeCodeFailure();
      const detail =
        result.stderr.trim() || result.stdout.trim() || "<no output>";
      throw new ClaudeCliError(
        `claude --print exited ${result.exitCode}: ${detail}`,
      );
    }
    output = result.stdout;
    return result.stdout;
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    // A missing CLI is not a crash of this caller: it is the machine's state,
    // and the Claude Code health row already shows it with the fix. Reporting
    // it here would file one report per background title/summary call.
    if (caughtError && !(caughtError instanceof ClaudeCodeUnavailableError)) {
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
