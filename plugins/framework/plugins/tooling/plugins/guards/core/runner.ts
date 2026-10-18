import { resolve } from "node:path";
import { GUARDS } from "./index";
import { HINTS } from "./hints";
import { createContext } from "./context";
import { withRefusalBanner } from "./refusal";
import type { Guard, ToolMatcher } from "./types";

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
  return Array.isArray(g) ? g.includes(tool as ToolMatcher) : g === tool;
}

const FILE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "Read"]);

function collectHints(
  tool: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): string[] {
  if (!FILE_TOOLS.has(tool)) return [];
  let filePath = toolInput.file_path as string | undefined;
  if (!filePath) return [];
  if (!filePath.startsWith("/")) filePath = resolve(cwd, filePath);
  return HINTS.filter(
    (h) =>
      (!h.tools || h.tools.includes(tool as ToolMatcher)) && h.match(filePath!),
  ).map((h) => h.message);
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
}

export async function runHook(
  input: HookInput,
  options: HookOptions,
): Promise<void> {
  const tool = input.tool_name;
  if (!tool) return;
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
  );
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

  const guards = GUARDS.filter((g) => matches(g.matcher, tool));
  // Facts contributed by guards that let the call through. Collected rather than
  // returned early, so one guard's answer never suppresses another's denial.
  const informs: string[] = [];
  // The input as rewritten so far. Every guard after a rewrite judges THIS —
  // what will actually run — and a later denial still wins over the rewrite.
  let current = toolInput;
  let rewritten = false;
  for (const guard of guards) {
    const verdict = await guard.check(current as never, ctx);
    if (verdict.kind === "inform") {
      informs.push(verdict.context);
      continue;
    }
    if (verdict.kind === "rewrite") {
      current = { ...current, ...verdict.patch };
      rewritten = true;
      continue;
    }
    if (verdict.kind === "deny") {
      // Every denial leads with what did NOT happen — added here, at the one
      // exit every guard's refusal passes through, so no guard can forget it.
      const reason = withRefusalBanner(tool, current, verdict.reason);
      process.stdout.write(
        JSON.stringify({
          ...(verdict.fatal ? { continue: false, stopReason: reason } : {}),
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
      return;
    }
  }

  const extra = [...informs, ...collectHints(tool, current, cwd)];
  if (extra.length > 0 || rewritten) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          // Without a `permissionDecision`, Claude Code applies `updatedInput`
          // and still defers to the permission system — a rewrite never
          // approves a call on its own.
          ...(rewritten ? { updatedInput: current } : {}),
          ...(extra.length > 0
            ? { additionalContext: extra.join("\n\n") }
            : {}),
        },
      }),
    );
  }
}
