import { loadGuards } from "./load-guards";
import {
  consumeInformed,
  recordInformed,
  repeatKey,
  wasInformed,
} from "./informed-once";
import { createContext } from "./context";
import { withRefusalBanner } from "./refusal";
import { parseShell } from "./parse-shell";
import { matchesTool, type Guard } from "./types";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import {
  bypassCommand,
  isBypassCall,
  parseBypassArgs,
} from "@plugins/framework/plugins/tooling/plugins/guards/plugins/bypass/core";

export interface HookInput {
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  /**
   * Claude Code stamps every hook payload with the session it came from. Read it
   * from here rather than from an ambient env var: the payload is the documented
   * contract, and a stateful guard that keys on the wrong identity either leaks
   * state between sessions or loses it within one.
   */
  session_id?: string;
  /**
   * The file Claude Code is writing this session's transcript to. Carries the
   * harness's own messages to the agent — notably a background task's
   * completion notification, which is the only authority on whether that task
   * is still running. See `GuardContext.readTranscript`.
   */
  transcript_path?: string;
  /**
   * Present ONLY when the call was made from inside a subagent — a documented
   * common hook field. Its absence is the signal, not a missing value: the main
   * conversation's own tool calls carry neither of these.
   *
   * This matters because a subagent and its parent are not interchangeable.
   * `session_id` and `transcript_path` above are the PARENT's on a subagent's
   * call (measured), which is the same conflation that loses a subagent's
   * background-task notification — so without these two fields a guard cannot
   * tell whose turn it is about to advise. See `background-ops`.
   */
  agent_id?: string;
  agent_type?: string;
  /** The id of the tool call this hook is judging — what the transcript keys its result by. */
  tool_use_id?: string;
}

function matches(g: Guard["matcher"], tool: string): boolean {
  return (Array.isArray(g) ? g : [g]).some((m) => matchesTool(m, tool));
}

/**
 * What the entry point must tell the runner, over and above the hook payload.
 *
 * REQUIRED, not defaulted: every field here is a fact `core/` cannot reach on
 * its own, and a default would silently be the wrong answer. A new entry point
 * that forgets `writableDataDirs` would start denying writes to the prototypes
 * tree again — with a `= []` default that regression is invisible, as a
 * required field it is a type error.
 */
export interface HookOptions {
  /** See `GuardContext.writableDataDirs` — resolved, absolute. */
  writableDataDirs: readonly string[];
  /**
   * The workspace root the launch named (`WORKSPACE_ROOT_ENV`), `null` in a
   * session no app launched — see `GuardContext.workRoot`.
   */
  workspaceRoot: string | null;
  /**
   * The scratch directory the launch named (`EQUIN_SCRATCH`), `null` in a
   * session no app launched — see `GuardContext.scratch`.
   */
  scratchDir: string | null;
}

/**
 * What the hook prints on stdout — Claude Code's PreToolUse output object —
 * or `null` to let the call through silently. Returned, not written, so the
 * entry point owns stdout (`bin/guard.ts` adds its fallback notice to it).
 */
export type HookOutput = Record<string, unknown>;

/** Appended to every `allowOnRepeat` denial — here, so no such guard can leave it out. */
export const REPEAT_TO_PROCEED =
  "This is a warning, not a hard block. If you have weighed the above and still need exactly this call, repeat it unchanged and it will run. A changed call is judged afresh.";

/**
 * Appended to every hard denial — here, so no guard can leave it out, and every
 * guard can be bypassed the same way. Never by default: the agent asks for it
 * per call, with a reason, after reading why it was refused.
 */
export function bypassToProceed(guard: string, id: string): string {
  return `Bypass — only if you are SURE this is a false positive and this exact call is safe (never by default, never to save a step; when in doubt, stop and ask the user): run \`${bypassCommand(id)}\` as its OWN tool call, then retry this call unchanged. That lets this one call through \`${guard}\` once; your reason stays in the transcript for review. A changed call is judged afresh.`;
}

/** The informed-once record of a bypass the agent asked for. */
const bypassRecord = (id: string): string => `bypass:${id}`;

type BypassStep =
  | { kind: "none" }
  | { kind: "asked"; id: string }
  | { kind: "refused"; why: string };

/**
 * A `./equin guard bypass <id> --reason …` call: recorded here, by the hook,
 * because only the hook knows the session and agent it belongs to (the CLI
 * verb just confirms). It must be the whole command — chained into the call it
 * bypasses, it would be judged in the same hook run, too late.
 */
function bypassStep(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): BypassStep {
  if (tool !== "Bash" || typeof input.command !== "string")
    return { kind: "none" };
  const { calls } = parseShell(input.command, cwd);
  const asks = calls.filter((c) => c.name === CLI_NAME && isBypassCall(c.args));
  if (asks.length === 0) return { kind: "none" };
  if (calls.length !== 1)
    return {
      kind: "refused",
      why: `Run \`./${CLI_NAME} guard bypass …\` as its own tool call, with nothing chained before or after it, then retry the denied call unchanged in the next one.`,
    };
  const parsed = parseBypassArgs(asks[0]!.args);
  if (!parsed.ok)
    return { kind: "refused", why: `Bypass not recorded: ${parsed.why}.` };
  return { kind: "asked", id: parsed.request.id };
}

export async function runHook(
  input: HookInput,
  options: HookOptions,
): Promise<HookOutput | null> {
  const tool = input.tool_name;
  if (!tool) return null;
  const cwd = input.cwd || process.cwd();
  const ctx = createContext(
    cwd,
    input.session_id || "unknown",
    options.writableDataDirs,
    input.transcript_path,
    input.agent_id === undefined
      ? null
      : { id: input.agent_id, type: input.agent_type ?? "unknown" },
    input.tool_use_id ?? null,
    options.workspaceRoot,
    options.scratchDir,
  );
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

  const agent = ctx.agent?.id ?? "main";

  const bypass = bypassStep(tool, toolInput, cwd);
  if (bypass.kind === "refused") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: withRefusalBanner(
          tool,
          toolInput,
          bypass.why,
        ),
      },
    };
  }
  if (bypass.kind === "asked")
    recordInformed(ctx.sessionId, agent, [bypassRecord(bypass.id)]);

  const guards = (await loadGuards()).filter(
    (g) =>
      matches(g.matcher, tool) &&
      !(g.once && wasInformed(ctx.sessionId, agent, g.name)),
  );
  // Facts contributed by guards that let the call through. Collected rather than
  // returned early, so one guard's answer never suppresses another's denial.
  const informs: string[] = [];
  const informedOnce: string[] = [];
  // The input as rewritten so far. Every guard after a rewrite judges THIS —
  // what will actually run — and a later denial still wins over the rewrite.
  let current = toolInput;
  let rewritten = false;
  for (const guard of guards) {
    const verdict = await guard.check(current as never, ctx);
    if (verdict.kind === "inform") {
      informs.push(verdict.context);
      if (guard.once) informedOnce.push(guard.name);
      continue;
    }
    if (verdict.kind === "rewrite") {
      current = { ...current, ...verdict.patch };
      rewritten = true;
      if (verdict.note !== null) informs.push(verdict.note);
      continue;
    }
    if (verdict.kind === "deny") {
      const key = repeatKey(guard.name, tool, cwd, current);
      // The agent asked to bypass exactly this call: used up here, once.
      if (consumeInformed(ctx.sessionId, agent, bypassRecord(key))) {
        informs.push(
          `\`${guard.name}\` was bypassed for this call, as you asked — it would otherwise have been refused.`,
        );
        continue;
      }
      let message = verdict.reason;
      if (verdict.allowOnRepeat) {
        // A warning, not a wall: refused the first time so the agent reads the
        // cost, let through when it repeats the identical call deliberately.
        // Recorded on the denial itself — that IS the telling.
        if (wasInformed(ctx.sessionId, agent, key)) continue;
        recordInformed(ctx.sessionId, agent, [key]);
        message += `\n\n${REPEAT_TO_PROCEED}`;
      } else {
        message += `\n\n${bypassToProceed(guard.name, key)}`;
      }
      // Every denial leads with what did NOT happen — added here, at the one
      // exit every guard's refusal passes through, so no guard can forget it.
      const reason = withRefusalBanner(tool, current, message);
      return {
        ...(verdict.fatal ? { continue: false, stopReason: reason } : {}),
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }
  }

  // Recorded only when the call goes through: a denial above returns without telling the
  // agent anything, so a `once` inform must still be pending for its retry.
  recordInformed(ctx.sessionId, agent, informedOnce);
  if (informs.length > 0 || rewritten) {
    return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          // Without a `permissionDecision`, Claude Code applies `updatedInput`
          // and still defers to the permission system — a rewrite never
          // approves a call on its own.
          ...(rewritten ? { updatedInput: current } : {}),
          ...(informs.length > 0
            ? { additionalContext: informs.join("\n\n") }
            : {}),
        },
    };
  }
  return null;
}
