import { recordAgentOpStart } from "../agent-ops";
import { defineGuard } from "../define-guard";
import { parseShell, type ShellParseResult } from "../parse-shell";
import type { BashInput, GuardContext } from "../types";
import { CLI_NAME } from "@plugins/framework/plugins/cli/core";

/**
 * Subcommands that take a host slot and run for minutes. From
 * `~/.singularity/logs/op-log/op-log.jsonl` over 14 days: build p50 9.8 min / p90 36.8 min,
 * push p50 9.1 min / p90 35.7 min, check p50 3.8 min / p90 18 min.
 */
const LONG_OPS = new Set(["build", "push", "check", "test", "release"]);

/** Read-only flags that answer instantly and never take a slot. */
const INSTANT_FLAGS = new Set(["--list", "--help", "-h", "--version", "-V"]);

/** Shell-level detach: looks like backgrounding, produces no tracked task. */
const SHELL_DETACH = new Set(["nohup", "setsid", "disown"]);

function longOpIn(parsed: ShellParseResult): string | null {
  for (const call of parsed.calls) {
    if (call.name !== CLI_NAME) continue;
    const sub = call.args.find((a) => !a.startsWith("-"));
    if (!sub || !LONG_OPS.has(sub)) continue;
    if (call.args.some((a) => INSTANT_FLAGS.has(a))) continue;
    return sub;
  }
  return null;
}

function shellDetachIn(parsed: ShellParseResult): boolean {
  if (parsed.calls.some((c) => SHELL_DETACH.has(c.name))) return true;
  // A trailing `&` survives tokenizing as its own empty segment, so look at the
  // text instead — but not `2>&1` / `&>file`, where the `&` is a redirection.
  // `code`, never the raw command: a script being WRITTEN by `cat > s.sh <<'EOF'`
  // whose last body line ends in `&` is not a detach.
  return /(?<![>&])&\s*$/.test(parsed.code.trim());
}

/**
 * Long Singularity ops must run as a tool-level background task.
 *
 * The foreground path caps at 600 s, which is below the median build. When it
 * expires the agent gets `Command timed out after 10m 0s` and nothing else — no
 * task id, no notification — while the process keeps running. From there it has
 * no handle on its own op, and the only thing left is to watch the leftover
 * output file, which is exactly the polling `poll-loop` exists to stop. 510 such
 * timeouts appear in 30 days of transcripts.
 *
 * `run_in_background: true` answers with "You will be notified when it
 * completes" and lives up to its `timeout` — 30 min by default, 2 h at most,
 * which `background-timeout` sets on every backgrounded `./equin` call.
 * Forcing every long op through it deletes the handle-less state entirely.
 *
 * ## The notification only arrives for the main conversation
 *
 * That last sentence is a promise the harness keeps for the main session and
 * breaks for a subagent — see {@link awaitInstead}. The op still runs correctly
 * backgrounded, so the guard's advice is unchanged; what changes is what the
 * caller does next. A subagent is told to hold its turn open on
 * `./equin await <op>`, and the ops it started are recorded so the
 * stop-guard can refuse a turn that walks away from one.
 */
/**
 * What a subagent must do instead of ending its turn.
 *
 * "You will be notified when it completes" is false for a subagent. The harness
 * builds that notification and files it under the PARENT session's queue, where
 * nothing delivers it: measured in conv-1789736383-4i30, two teammates ended
 * their turns on a background `check` and `test`, both exited 0 two minutes
 * later, and neither agent moved again for nine hours. Upstream
 * anthropics/claude-code #88423 / #87689 / #85534, all open.
 *
 * So the subagent is told to convert the wake-up it will not receive into one it
 * cannot miss: the result of its own next tool call.
 */
function awaitInstead(op: string): string {
  return (
    `You are a subagent, so the completion notification for this ${op} will NOT reach you — ` +
    `the harness files it under the parent session's queue and nothing delivers it there. ` +
    `Do NOT end your turn expecting to be woken.\n` +
    `Your next call must be: \`./equin await ${op}\` (foreground). It blocks until the ` +
    `${op} writes its verdict and prints it, so the wake-up becomes this call's own result. ` +
    `If it exits 70 the op is simply still going — run it again.`
  );
}

/** Note whose op this is, so the stop hook can tell it apart from its parent's. */
function recordOwnership(ctx: GuardContext, op: string): void {
  if (!ctx.agent) return;
  recordAgentOpStart(ctx.sessionId, {
    agentId: ctx.agent.id,
    op,
    cwd: ctx.cwd,
    at: Date.now(),
  });
}

export const backgroundOpsGuard = defineGuard<BashInput>({
  name: "background-ops",
  matcher: "Bash",
  // For the rare op that must be watched live (debugging the build itself).
  bypassToken: ".allow-foreground-ops",
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd) return null;

    const parsed = parseShell(cmd);
    const op = longOpIn(parsed);
    if (!op) return null;

    if (input.run_in_background === true) {
      if (!shellDetachIn(parsed)) {
        // The backgrounding itself is right for everyone — the op runs detached
        // and tracked. What differs is who gets told when it ends.
        if (!ctx.agent) return null;
        recordOwnership(ctx, op);
        return { inform: awaitInstead(op) };
      }
      return {
        blocked: `This command already runs in the background — the extra shell-level detach (\`&\`/\`nohup\`) breaks it.`,
        why: "Detaching inside the shell makes the task exit immediately, so the harness records a completed task while the op is still running. You are then notified about the wrong thing.",
        hint: `Drop the trailing \`&\` (and any \`nohup\`/\`setsid\`) and keep \`run_in_background: true\`.`,
      };
    }

    if (shellDetachIn(parsed)) {
      return {
        blocked: `\`./equin ${op}\` is being detached by the shell, which produces no tracked task.`,
        why: "A shell-detached process is invisible to the harness: nothing notifies you when it ends, so the only way to learn the outcome is to watch a file. That is the polling loop this repo is trying to remove.",
        hint: `Drop the \`&\`/\`nohup\` and pass \`run_in_background: true\` on the Bash tool call instead.`,
      };
    }

    return {
      blocked: `\`./equin ${op}\` must run with \`run_in_background: true\`.`,
      why: `A ${op} takes about 10 minutes at the median and regularly exceeds the 600 s foreground limit. On timeout you get "Command timed out after 10m 0s" — no task id, no notification — while the op keeps running, leaving you with no handle on it.`,
      hint: ctx.agent
        ? `Re-run the same command with \`run_in_background: true\`, then — WITHOUT ending your turn — call \`./equin await ${op}\`. ${awaitInstead(op)}`
        : `Re-run the same command with \`run_in_background: true\`, then END YOUR TURN. The timeout is raised to the 2 h ceiling for you, and you will be re-invoked with the output when it finishes. Do not sit and watch it.`,
    };
  },
});
