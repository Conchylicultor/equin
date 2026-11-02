import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  joinAppPath,
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { parseArgv } from "../argv";
import { defineGuard } from "../define-guard";
import type { Denial, Inform } from "../define-guard";
import { parseShell } from "../parse-shell";
import { readTaskReport } from "../task-reports";
import {
  classify,
  detectPoll,
  pruneWindow,
  THRESHOLD,
  watchesNothing,
  watchSubjects,
  type WatchSubject,
  type WindowEntry,
} from "../poll-detect";
import type { BashInput, GuardContext } from "../types";
import {
  asNamespace,
  isNamespace,
} from "@plugins/infra/plugins/namespace/core";

interface State {
  window: WindowEntry[];
  /** Subjects already denied once — a repeat escalates. */
  tripped: WatchSubject[];
}

const EMPTY: State = { window: [], tripped: [] };

function stateFile(sessionId: string): AppPath {
  return joinAppPath(asAppPath(tmpdir()), `guard-poll-loop-${sessionId}.json`);
}

function loadState(path: AppPath): State {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    return { window: parsed.window ?? [], tripped: parsed.tripped ?? [] };
  } catch (err) {
    // A torn or hand-edited state file must not block the agent's next call.
    if (
      !(err instanceof SyntaxError) &&
      (err as NodeJS.ErrnoException).code == null
    )
      throw err;
    return { ...EMPTY };
  }
}

/* ------------------------------------------------------------------ liveness */

/**
 * Is the thing being watched still running? Decides whether a repeated look is
 * a wait (deny — something else will wake you) or forensics on a finished op
 * (allow — reading a completed build's log four times is legitimate work).
 *
 * Every arm here is a LIVENESS state. There used to be a `harness-task` arm as
 * well, which was a category rather than a state, and it sat first in the walk
 * below — so a background task could never reach `finished` no matter how long
 * ago it had ended. Twenty of the 36 denials in a 30-day corpus were that arm
 * firing on a task the harness had already reported, most within a minute of
 * the notification: an agent mining a finished run's output, told it would be
 * "re-invoked when it exits" by something it had already been woken by. What
 * makes a harness task special is that its liveness has an authority to consult
 * (`readTaskReport`) and that its wake-up is automatic (`wakesYou`), not that
 * it is exempt from the question.
 *
 * `nothing-watched` is the answer for a command that names no thing at all (a
 * bare `sleep`, an `echo` of fixed text). There is nothing whose state could
 * change, so it is not `unknown`: the looks are known to be empty.
 */
type Liveness =
  | { kind: "running"; what: string; wakesYou: boolean }
  | { kind: "finished"; verdict: string }
  | { kind: "nothing-watched" }
  | { kind: "unknown" };

interface RawReceipt {
  status?: string;
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  url?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: gone. EPERM: alive but owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function minutesSince(iso: string | undefined): string {
  if (!iso) return "";
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  return ` (started ${Math.round((Date.now() - started) / 60000)}m ago)`;
}

function receiptLiveness(worktree: string): Liveness {
  // The name is parsed out of a watch-subject string, so it is untrusted input:
  // one that is not a namespace names no receipt, which is the same answer as a
  // receipt that isn't there.
  if (!isNamespace(worktree)) return { kind: "unknown" };
  let raw: RawReceipt;
  try {
    raw = JSON.parse(
      readFileSync(
        worktreeArtifacts.buildStatus(asNamespace(worktree)),
        "utf8",
      ),
    ) as RawReceipt;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "unknown" };
    if (err instanceof SyntaxError) return { kind: "unknown" };
    throw err;
  }
  const what = `The build in ${worktree}`;
  // `running` with a dead pid means killed before it could rewrite the receipt —
  // still finished, just without a verdict of its own.
  if (raw.status === "running") {
    return raw.pid != null && pidAlive(raw.pid)
      ? {
          kind: "running",
          what: `${what}${minutesSince(raw.startedAt)}, pid ${raw.pid},`,
          wakesYou: false,
        }
      : {
          kind: "finished",
          verdict: `${what} was interrupted — the build process died without writing a verdict`,
        };
  }
  if (raw.status == null) return { kind: "unknown" };
  return {
    kind: "finished",
    verdict: `${what} finished: ${raw.status}${raw.exitCode != null ? ` (exit ${raw.exitCode})` : ""}`,
  };
}

/**
 * A background task's liveness, from the only thing that knows it: whether the
 * harness has written its completion notification into the transcript.
 */
function taskLiveness(ctx: GuardContext, id: string): Liveness {
  const what = `Background task ${id}`;
  const report = readTaskReport(ctx.readTranscript(), id);
  switch (report.kind) {
    case "reported":
      return {
        kind: "finished",
        verdict: `the harness reported ${id} ${report.status} — the notification you were told to wait for has already arrived`,
      };
    case "no-report":
    // No notification is the definition of "has not finished".
    case "unreadable":
      // Not knowing is not the same as still running, but the honest fallback
      // is the behaviour that predates the transcript read: its message ("you
      // will be re-invoked when it exits") is true of a task yet to report.
      return { kind: "running", what, wakesYou: true };
  }
}

/**
 * Newest mtime among the files a command actually reads, recorded at every look
 * so `unchangedAcross` can compare them.
 *
 * `undefined` is not a timestamp that failed to be read — it is "this look is
 * no evidence about a static file": the command read no file at all, or read
 * one that does not exist yet (waiting for a file to APPEAR is the pathological
 * loop, not forensics) or is still empty (an empty output is not a result).
 *
 * ## Why a non-existent operand is skipped, not disqualifying
 *
 * `argv.ts` models the commands that WRITE, so a reader nobody modelled falls
 * through to the default grammar where every non-flag token is an operand —
 * `grep -c "sub-ack" app.jsonl` names a file called `sub-ack`, `jq '.result' f`
 * one called `.result`. That over-collection is the safe direction for a guard
 * asking "what might this command clobber", and the wrong one here.
 *
 * Skipping what does not resolve is not the same guess in reverse. A write
 * guard must never MISS a target, so it takes every candidate; this one must
 * never INVENT a file, and a token naming nothing on disk is not a file the
 * command read — a fact, not an inference. What the two share is that neither
 * builds a path itself: both read the operands `parseArgv` resolved.
 */
function namedFilesMtime(cmd: string): number | undefined {
  const paths = parseShell(cmd).calls.flatMap((call) =>
    parseArgv(call).files.flatMap((f) => (f.kind === "local" ? [f.path] : [])),
  );

  let newest: number | undefined;
  for (const path of paths) {
    let stat;
    try {
      stat = statSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code == null) throw err;
      continue; // a pattern, a jq filter, or a file not written yet
    }
    if (!stat.isFile() || stat.size === 0) continue;
    newest = Math.max(newest ?? 0, stat.mtimeMs);
  }
  return newest;
}

/**
 * Is anything still writing to what this command reads?
 *
 * The answer for a subject with no authority of its own to consult — a log
 * channel, a build log. Every look in this loop saw the same mtime, so nothing
 * appended between the first and this one: the looks are questions about a file
 * that stopped changing, not waits for it to change.
 *
 * Comparing the RECORDED mtimes rather than one mtime against the window's
 * start is what makes this exact. A file written moments before the first look
 * is older than that look, yet a live log appended to between looks is too if
 * the looks come fast enough — either way the timestamps only bracket the
 * question. Equality across the looks answers it outright and needs no margin.
 */
function unchangedAcross(
  looks: WindowEntry[],
  now: number | undefined,
): Liveness {
  if (now === undefined || looks.length === 0) return { kind: "unknown" };
  if (!looks.every((e) => e.m === now)) return { kind: "unknown" };
  return {
    kind: "finished",
    verdict: "nothing has written to it since your first look",
  };
}

function livenessOf(
  subjects: WatchSubject[],
  ctx: GuardContext,
  looks: WindowEntry[],
  mtime: number | undefined,
): Liveness {
  if (watchesNothing(subjects)) return { kind: "nothing-watched" };
  for (const s of subjects) {
    if (s.startsWith("task:"))
      return taskLiveness(ctx, s.slice("task:".length));
  }
  for (const s of subjects) {
    if (s.startsWith("receipt:build:")) {
      const wt = s.slice("receipt:build:".length);
      if (wt !== "self") return receiptLiveness(wt);
    }
    if (s.startsWith("pid:")) {
      const pid = Number(s.slice("pid:".length));
      if (Number.isFinite(pid)) {
        return pidAlive(pid)
          ? { kind: "running", what: `Process ${pid}`, wakesYou: false }
          : { kind: "finished", verdict: `pid ${pid} has exited` };
      }
    }
  }
  return unchangedAcross(looks, mtime);
}

/* -------------------------------------------------------------------- message */

/**
 * `finished` is excluded rather than handled: a thing that has stopped changing
 * is never a reason to block, and `check` turns it into an `inform` before it
 * gets here. This used to be a fourth arm that nothing could reach — dead
 * prose that read as though the guard blocked finished ops too. As a type it
 * cannot rot: routing a `finished` liveness into a denial is a `tsc` error.
 */
function denialFor(
  liveness: Exclude<Liveness, { kind: "finished" }>,
  subjects: WatchSubject[],
  fatal: boolean,
): Denial {
  const watching = subjects.join(", ");
  const base = {
    blocked: `This is the 4th look at the same thing (${watching}) with no work in between — a polling loop.`,
    fatal,
  };

  switch (liveness.kind) {
    case "running":
      return liveness.wakesYou
        ? {
            ...base,
            why: `${liveness.what} has not reported in yet, and it is tracked by the harness. When it exits you are re-invoked automatically with its output — that is what "You will be notified when it completes" meant.`,
            hint: "END YOUR TURN now. Do not check the task again; there is nothing to see until it finishes, and you will be woken when it does.",
          }
        : {
            ...base,
            why: `${liveness.what} is still running. Watching it costs a turn per look and changes nothing.`,
            hint: "END YOUR TURN. If this op is one of your own background tasks you will be re-invoked when it finishes. If it is not, say so to the user rather than waiting on it.",
          };
    case "nothing-watched":
      return {
        ...base,
        blocked:
          "This is the 4th command with no work in between that only passes time (a bare `sleep`, or an `echo` of fixed text) — a wait loop.",
        why: "It watches no file, process or task, so repeating it cannot show you anything new, and every call still costs a full turn. The agents and background tasks you started notify you when they finish; ending your turn is how you wait for them.",
        hint: "END YOUR TURN now. If nothing you started is going to wake you, tell the user what you are waiting for instead.",
      };
    case "unknown":
      return {
        ...base,
        why: "Nothing here is going to wake you: this is not one of your background tasks, so no notification is coming no matter how long you watch.",
        hint: "STOP and tell the user what you are waiting for and why. If you started this op yourself, re-run it with `run_in_background: true` so its completion notifies you.",
      };
  }
}

/* ---------------------------------------------------------------------- guard */

/**
 * Blocks the loop where an agent spends turns watching something finish.
 *
 * Measured over 30 days of transcripts: 47 sessions contained a run of 6+
 * consecutive calls observing one thing, 528 calls in those runs alone. The
 * guard this replaces keyed on byte-identical consecutive commands and caught 2
 * of them — in 40 of the 45 misses the longest identical streak was 1, because
 * incidental drift (`tail -25` → `-40`) is enough to defeat byte-equality.
 *
 * The identity here is the SUBJECT being watched, so drift does not help. See
 * `../poll-detect.ts` for the rule and `e2e/replay-transcripts.ts` for its
 * measured catch rate.
 */
export const pollLoopGuard = defineGuard<BashInput>({
  name: "poll-loop",
  matcher: "Bash",
  check(input, ctx: GuardContext): Denial | Inform | null {
    const cmd = input.command?.trim();
    if (!cmd) return null;

    const path = stateFile(ctx.sessionId);
    const state = loadState(path);
    const now = Date.now();
    const kind = classify(cmd);

    // Real work happened — whatever the agent was waiting on, it is no longer
    // just waiting. Forget the looks that came before.
    if (kind === "mutate") {
      writeFileSync(
        path,
        JSON.stringify({ window: [], tripped: [] } satisfies State),
      );
      return null;
    }
    if (kind === "neutral") return null;

    const subjects = watchSubjects(cmd);
    // Recorded on EVERY look, not only on a trip: the question `unchangedAcross`
    // answers is what the file looked like at each earlier look, which cannot be
    // reconstructed after the fact.
    const mtime = namedFilesMtime(cmd);
    const entry: WindowEntry = { t: now, s: subjects, m: mtime };
    const { repeated, tripped } = detectPoll(subjects, state.window, now);

    if (!tripped) {
      state.window = pruneWindow([...state.window, entry], now);
      writeFileSync(path, JSON.stringify(state));
      return null;
    }

    const looks = pruneWindow(state.window, now).filter((e) =>
      e.s.some((s) => repeated.includes(s)),
    );
    const liveness = livenessOf(subjects, ctx, looks, mtime);

    // Forensics on something already finished is legitimate — answer the
    // question instead of blocking it, and let the window keep filling.
    if (liveness.kind === "finished") {
      state.window = pruneWindow([...state.window, entry], now);
      writeFileSync(path, JSON.stringify(state));
      return {
        inform: `You have now looked at ${repeated.join(", ")} ${THRESHOLD} times, and it is no longer changing — ${liveness.verdict}. Read what you have and move on.`,
      };
    }

    const seenBefore = repeated.some((s) => state.tripped.includes(s));
    state.tripped = [...new Set([...state.tripped, ...repeated])];
    writeFileSync(path, JSON.stringify(state));

    return denialFor(liveness, repeated, seenBefore);
  },
});
