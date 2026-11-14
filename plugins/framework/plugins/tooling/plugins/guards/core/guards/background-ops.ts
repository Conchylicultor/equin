import { recordAgentOpStart } from "../agent-ops";
import { defineGuard } from "../define-guard";
import {
  parseShell,
  type ShellCall,
  type ShellParseResult,
} from "../parse-shell";
import type { BashInput, GuardContext } from "../types";
import {
  CLI_NAME,
  CLI_NAME_PATTERN,
} from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { isHandoffOp } from "@plugins/framework/plugins/cli/plugins/foreground-handoff/core";

/**
 * Subcommands that take a host slot and run for minutes. From
 * `~/.equin/logs/op-log/op-log.jsonl` over 14 days: build p50 9.8 min / p90 36.8 min,
 * push p50 9.1 min / p90 35.7 min, check p50 3.8 min / p90 18 min.
 */
const LONG_OPS = new Set(["build", "push", "check", "test", "release"]);

/** Read-only flags that answer instantly and never take a slot. */
const INSTANT_FLAGS = new Set(["--list", "--help", "-h", "--version", "-V"]);

/** Shell-level detach: looks like backgrounding, produces no tracked task. */
const SHELL_DETACH = new Set(["nohup", "setsid", "disown"]);

/** Every long op the command runs, in order (a chain can run several). */
export function longOpsIn(parsed: ShellParseResult): string[] {
  const ops: string[] = [];
  for (const call of parsed.calls) {
    if (call.name !== CLI_NAME) continue;
    const sub = call.args.find((a) => !a.startsWith("-"));
    if (!sub || !LONG_OPS.has(sub)) continue;
    if (call.args.some((a) => INSTANT_FLAGS.has(a))) continue;
    ops.push(sub);
  }
  return ops;
}

/** The ops a foreground call is moved to the background for, rather than refused. */
const REWRITTEN_OPS = new Set(["build", "push"]);

/** The call's text starts with the CLI itself: no env prefix, no `time` wrapper. */
const CLI_HEAD = new RegExp(`^(?:\\S*/)?${CLI_NAME_PATTERN}\\s`);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `cd <one literal dir>`: it only sets the directory, which a background run keeps. */
function isPlainCd(call: ShellCall): boolean {
  return (
    call.name === "cd" &&
    call.args.length === 1 &&
    !call.args[0]!.startsWith("-") &&
    !/[$`]/.test(call.raw)
  );
}

/** `tail -N` / `tail -n N`: the end of the op's output, read once it is over. */
function isTailCount(call: ShellCall): boolean {
  if (call.name !== "tail" || call.redirections.length > 0) return false;
  const a = call.args;
  return (
    (a.length === 1 && /^-\d+$/.test(a[0]!)) ||
    (a.length === 2 && a[0] === "-n" && /^\d+$/.test(a[1]!))
  );
}

/**
 * The one op the command consists of, when backgrounding it cannot change what
 * the command means: a single `./equin build|push` call with its flags, and at
 * most
 *
 * - a `2>&1`;
 * - for a push, the `-m "$(cat <<'EOF' … EOF)"` message idiom (its `cat` reads
 *   the heredoc, so it is the message, not a step);
 * - a leading `cd <dir> &&` (or `;`) — the directory the op runs in either way;
 * - a trailing `| tail -N` — the end of its output, which a background run
 *   delivers when it is over, exactly when a foreground one would; `pipefail`
 *   keeps the op's own exit status.
 *
 * Those are the shapes the refused calls actually had: replayed over 7 days
 * (2026-11-14), 32 of background-ops' 78 denials are rewritten — and the bare
 * form alone was none of them, so a rule without the `cd` and `tail` arms
 * would have rewritten 0. Anything else stays refused, because
 * a background run would read it differently: another command chained before
 * or after (`git status &&`, `; git status` — its output would arrive at the
 * end, out of order), a wrapper (`time` would time the hand-off), `head` (stops
 * reading early), a file redirection, an env prefix.
 */
function soleRewritableOp(
  cmd: string,
  parsed: ShellParseResult,
): string | null {
  const op = parsed.calls.find((c) => c.name === CLI_NAME);
  if (op === undefined) return null;
  const sub = op.args.find((a) => !a.startsWith("-"));
  if (sub === undefined || !REWRITTEN_OPS.has(sub)) return null;
  if (!CLI_HEAD.test(op.raw.trim())) return null;
  if (op.redirections.some((r) => r.kind !== "fd" || r.toFd !== "1"))
    return null;

  // A heredoc was stripped from the text (so the `cat` reads it, not stdin).
  const heredocMessage = parsed.code !== cmd && /\$\(cat\s/.test(op.raw);
  const steps = parsed.calls.filter(
    (c) => !(heredocMessage && c.name === "cat" && c.args.length === 0),
  );
  const at = steps.indexOf(op);
  const before = steps.slice(0, at);
  const after = steps.slice(at + 1);
  if (before.length > 1 || (before[0] && !isPlainCd(before[0]))) return null;
  if (after.length > 1 || (after[0] && !isTailCount(after[0]))) return null;

  // The calls alone do not say how they are joined: the text must be exactly
  // `[cd … && | ;] <op> [| tail …]`, nothing around or between them.
  const shape = new RegExp(
    "^" +
      (before[0] ? `${escapeRe(before[0].raw)}\\s*(?:&&|;)\\s*` : "") +
      escapeRe(op.raw.trim()) +
      (after[0] ? `\\s*\\|\\s*${escapeRe(after[0].raw)}` : "") +
      "$",
  );
  return shape.test(parsed.code.trim()) ? sub : null;
}

/**
 * What the agent is told when its foreground op was moved to the background:
 * that it happened, and what to do next — which differs for a subagent.
 */
function rewriteNote(op: string, subagent: boolean): string {
  const moved =
    `\`./equin ${op}\` was typed in the foreground; it was started with \`run_in_background: true\` instead ` +
    `(a ${op} regularly outlives the 600 s foreground limit). The command itself is unchanged.`;
  return subagent
    ? `${moved}\n${awaitInstead(op)}`
    : `${moved}\nEND YOUR TURN now: you will be re-invoked with its output when it finishes. Do not watch it.`;
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
 * Long equin ops must run as a tool-level background task.
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
 * When the command is just the op ({@link soleRewritableOp}) the guard does
 * that itself — rewrites the call to `run_in_background: true` with a note —
 * instead of refusing it: the retry was the same command backgrounded every
 * time, and each refusal cost a turn. Every other shape is still refused.
 *
 * ## Except the ones that hand themselves off
 *
 * `check` and `test` are usually short (p50 192 s / 35 s), so a forced
 * background run cost a turn end and a re-invocation for a result that was
 * often seconds away — and blocked every other command typed in the same call.
 * They run in the foreground instead: `foreground-deadline` exports the call's
 * deadline, and the op hands itself off before it (`cli/foreground-handoff`),
 * so the handle-less timeout cannot happen to them either. Only the ops that
 * cannot hand off are held to the background.
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
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd) return null;

    const parsed = parseShell(cmd);
    const ops = longOpsIn(parsed);
    const op = ops[0];
    if (op === undefined) return null;

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

    // Foreground is fine for ops that hand off at the call's deadline; a chain
    // is held to the background by any op in it that cannot.
    const pinned = ops.find((o) => !isHandoffOp(o));
    if (pinned === undefined) {
      // A hand-off leaves the op running past this call, so the stop hook
      // must know whose it is, exactly as for a backgrounded one.
      for (const o of ops) recordOwnership(ctx, o);
      return null;
    }

    // The denial's fix is mechanical when the command IS the op: the retry was
    // the same command backgrounded every time (research/
    // 2026-11-14-guards-false-positive-audit.md). Do it for the agent — the
    // timeout is raised by `background-timeout`, which judges the rewritten
    // input — and record the op as a backgrounded one is.
    const rewritable = soleRewritableOp(cmd, parsed);
    if (rewritable !== null) {
      recordOwnership(ctx, rewritable);
      return {
        rewrite: { run_in_background: true },
        note: rewriteNote(rewritable, ctx.agent !== null),
      };
    }
    return {
      blocked: `\`./equin ${pinned}\` must run with \`run_in_background: true\`.`,
      why: `A ${pinned} takes about 10 minutes at the median and regularly exceeds the 600 s foreground limit. On timeout you get "Command timed out after 10m 0s" — no task id, no notification — while the op keeps running, leaving you with no handle on it.`,
      hint: ctx.agent
        ? `Re-run the same command with \`run_in_background: true\`, then — WITHOUT ending your turn — call \`./equin await ${pinned}\`. ${awaitInstead(pinned)}`
        : `Re-run the same command with \`run_in_background: true\`, then END YOUR TURN. The timeout is raised to the 2 h ceiling for you, and you will be re-invoked with the output when it finishes. Do not sit and watch it.`,
    };
  },
});
