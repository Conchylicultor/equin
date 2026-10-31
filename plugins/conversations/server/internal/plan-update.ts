import type {
  Conversation,
  ConversationWorkingOn,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { UpdateConversationPatch } from "@plugins/tasks/plugins/tasks-core/server";
import { decideMissingProcessAction } from "./hibernation-decision";
import type { RuntimeInfo } from "./runtime";
import type { QuestionHold } from "./question-hold";
import {
  QUESTION_WAITING_FOR,
  STUCK_TURN_WAITING_FOR,
} from "../../core/turn-gate";

// The status reconciler's decision, as a pure function of one conversation row
// and what its runtime says about it. Everything with an effect — the DB writes,
// the session-id gate's file reads, reports, the auto-open flush — stays in the
// shell (status-reconciler.ts), which applies the plan this returns.

/**
 * Grace window for a "starting" row with NO spawn job in flight and no live
 * session — a launch whose `runtime.create` runs inline in a request (a fork
 * into an existing attempt, a resume), with nothing durable to ask. Past it,
 * assume that create never came up (the backend died mid-create) and mark gone
 * so the UI moves off "Starting…".
 *
 * Never applied while the row's `conversations.spawn` job is still coming
 * (`PlanContext.spawnInFlight`): the job owns its launch — a restart re-runs
 * it, a failure retries it — and a clock cannot tell a spawn still on its way
 * from one that gave up. Sweeping on the clock while the job was waiting out a
 * restart is how a launch came up 30 s after its row had been called gone.
 */
export const STARTING_TIMEOUT_MS = 30_000;

/**
 * How long an agent at rest may hold a turn it was handed (turn ledger
 * `typing` / `typed`) without starting it before it reads **stuck** rather
 * than working. An idle CLI starts a queued turn at once, and a fresh one
 * within seconds of booting (4–6 s measured; far more under host duress — the
 * runtime's own unresponsive bound is the same 5 min). Past it, nothing the
 * agent does will move the turn: its Claude Code process is wedged while
 * alive, which neither its exit nor a new process's start (the events that
 * release a pending turn) will ever say. A bound around the CLI — a process
 * we do not control — not a timer on our own work; the minute status sweep
 * is what notices it elapse.
 */
export const STUCK_TURN_MS = 5 * 60_000;

/** The fields of a conversation row the decision reads. */
export type PlanRow = Pick<
  Conversation,
  | "status"
  | "closeRequested"
  | "claudeSessionId"
  | "waitingFor"
  | "workingOn"
  | "createdAt"
  | "hibernatedAt"
  | "statusUnverifiedSince"
>;

/** What the runtime says about one conversation. */
export type Liveness =
  /** A live (or dead-but-listed) session. */
  | { kind: "live"; info: RuntimeInfo }
  /** The runtime answered and has no session for it. */
  | { kind: "absent" }
  /**
   * Its state is unknown: the runtime failed to answer as a whole, or it
   * answered but could not vouch for this conversation (`unverified`).
   */
  | { kind: "unknown"; reason: string };

export interface PlanContext {
  onMain: boolean;
  now: number;
  /**
   * Whether the live session id passed `sessionGate` — the async gate the
   * shell runs only when {@link sessionCandidate} names one.
   */
  sessionAccepted: boolean;
  /**
   * The conversation's open question (question-hold.ts), or null when nothing
   * holds one: an `open` hold is what the conversation waits on.
   */
  questionHold: QuestionHold | null;
  /**
   * When the CLI last confirmed submitting a turn (the turn ledger's
   * `submitted_at`), or null when it never did.
   */
  lastSubmitAt: Date | null;
  /**
   * When the conversation's oldest turn its agent has not started yet but
   * should on its own entered that state (the turn ledger's
   * `pendingTurnsSince`: being sent, or queued in its CLI) — the launch prompt
   * while the CLI boots, a turn queued behind the one that just ended — or
   * null when it holds none.
   */
  pendingTurnSince: Date | null;
  /**
   * Whether the conversation's `conversations.spawn` job is still coming —
   * queued, waiting out a retry, running, or suspended waiting on its
   * workspace (a worktree checkout) (`spawnConversationJob.inFlight`,
   * read BEFORE the runtime is asked, so a spawn that finished in between is
   * seen live). While it is, a "starting" row with no session is the job's to
   * settle, however long it takes.
   */
  spawnInFlight: boolean;
}

export type UpdatePlan =
  | { kind: "noop" }
  | { kind: "closed" }
  /**
   * Mark gone. `stuckStartingMs` is set when a "starting" row never came up —
   * the shell reports that the safety net fired.
   */
  | { kind: "gone"; stuckStartingMs: number | null }
  /**
   * Stamp `hibernatedAt`. `endTurn` is set when the row still says `working`:
   * with no process, nothing is computing, so the row is settled to `waiting`
   * in the same reconcile (see `planAbsent`).
   */
  | {
      kind: "hibernate";
      endTurn: boolean;
      /** Clear `statusUnverifiedSince` in the same reconcile. */
      clearUnverified?: true;
    }
  | {
      kind: "patch";
      patch: UpdateConversationPatch;
      /** A new session id to append to the chain (behind the gate). */
      adoptedSessionId: string | null;
      /**
       * Set when this write makes the row stuck (it was not): since when its
       * agent has rested holding the unstarted turn — the shell reports it.
       */
      stuckSince?: Date;
    };

/**
 * A live session's status, `workingOn` riding with `working`. `stuck` is
 * written as `waiting` with `waitingFor` {@link STUCK_TURN_WAITING_FOR}: the
 * agent will not move on its own, so it is not busy, and its state is in front
 * of the user — not as an idle agent's finished work, but as a wedge to clear.
 */
export type LiveStatus =
  | { status: "working"; workingOn: ConversationWorkingOn }
  | { status: "waiting" }
  | { status: "stuck"; since: Date };

/**
 * Working on what the runtime says the agent is busy with — or on a turn when
 * the turn ledger says one is on its way:
 *
 * - confirmed submitted after the runtime's last status write: an idle written
 *   BEFORE the submit is stale evidence; one written after it (the turn ended,
 *   or was interrupted) is current. Causal order, not a grace timer.
 * - pending (`pendingTurnSince`): handed to the agent, or about to be, and
 *   not started yet. The agent will start it with nobody doing anything, so it
 *   is not at rest — `waiting` would say its work is in front of the user, and
 *   every reader of the status (a watch going quiet, list_agents) would act on
 *   that. The launch prompt while the CLI boots (seconds) and a turn queued
 *   behind the one that just ended are the gaps it closes.
 *
 * A pending turn is evidence of work only for so long. When it is the ONLY
 * evidence — the runtime says the agent is at rest, no confirmed submit since
 * — and the agent has been at rest with it for {@link STUCK_TURN_MS} (counted
 * from the later of the runtime's last status write and the turn entering its
 * pending state, so a turn queued for an hour behind a long turn starts its
 * clock when that turn ends), the agent is `stuck`: an idle CLI that does not
 * start a turn it holds will not start it later, and `working` would then be
 * a claim nothing ever revokes.
 */
export function liveStatusFor(
  info: RuntimeInfo,
  lastSubmitAt: Date | null,
  pendingTurnSince: Date | null,
  now: number,
): LiveStatus {
  const submittedSince =
    lastSubmitAt !== null &&
    info.statusWrittenAt !== null &&
    lastSubmitAt > info.statusWrittenAt;
  if (submittedSince) return { status: "working", workingOn: "turn" };
  if (pendingTurnSince !== null && info.workingOn !== "turn") {
    const restingWithIt = Math.max(
      pendingTurnSince.getTime(),
      info.statusWrittenAt?.getTime() ?? 0,
    );
    if (now - restingWithIt < STUCK_TURN_MS)
      return { status: "working", workingOn: "turn" };
    // Background work still wakes it on its own: busy, as it says.
    if (info.workingOn === null)
      return { status: "stuck", since: new Date(restingWithIt) };
  }
  if (info.workingOn !== null)
    return { status: "working", workingOn: info.workingOn };
  return { status: "waiting" };
}

/**
 * The session id the shell must run `sessionGate` on before planning, or
 * null when there is nothing to gate: only on the rare reconcile where the
 * runtime reports an id different from the stored one, never on the steady
 * state.
 */
export function sessionCandidate(row: PlanRow, live: Liveness): string | null {
  if (live.kind !== "live") return null;
  const id = live.info.claudeSessionId;
  return id && id !== row.claudeSessionId ? id : null;
}

/** Decide what one reconcile writes for one conversation. */
export function planConversationUpdate(
  row: PlanRow,
  live: Liveness,
  ctx: PlanContext,
): UpdatePlan {
  // "done" means a deliberate close (exit_clean / toolbar Exit) — never
  // overwrite it back to working/waiting just because the agent's session
  // hasn't been reaped yet.
  if (row.status === "done") return { kind: "noop" };

  switch (live.kind) {
    case "live":
      return verified(row, planLive(row, live.info, ctx));
    case "unknown":
      return planUnknown(row, ctx);
    case "absent":
      return verified(row, planAbsent(row, ctx));
  }
}

/**
 * Unknown — the runtime failed to answer (a socket error under FD pressure),
 * or the agent answers but this backend has not applied its latest events: we
 * can't tell what the agent is doing. `status` stays the last KNOWN one —
 * never declare every working/waiting conversation gone on a hiccup, and
 * never plan from a stale projection — and the row is marked unverified, so
 * readers show "Unknown" instead of claiming it. The mark keeps its first
 * time (the row says since when), and the next reconcile that can check
 * clears it ({@link verified}).
 *
 * A whole-runtime failure marks too: the status really is unverified then.
 * It cannot flap faster than reconciles run — the next one that answers (a
 * push signal, or the minute sweep) clears it — and the failure itself is
 * reported by the shell.
 */
function planUnknown(row: PlanRow, ctx: PlanContext): UpdatePlan {
  if (row.statusUnverifiedSince !== null) return { kind: "noop" };
  return {
    kind: "patch",
    patch: { statusUnverifiedSince: new Date(ctx.now) },
    adoptedSessionId: null,
  };
}

/**
 * A decision made from a checked state ends any unverified stretch: `plan`
 * plus clearing `statusUnverifiedSince` when it is set. `gone` and `closed`
 * clear it in their own write.
 */
function verified(row: PlanRow, plan: UpdatePlan): UpdatePlan {
  if (row.statusUnverifiedSince === null) return plan;
  switch (plan.kind) {
    case "noop":
      return {
        kind: "patch",
        patch: { statusUnverifiedSince: null },
        adoptedSessionId: null,
      };
    case "patch":
      return { ...plan, patch: { ...plan.patch, statusUnverifiedSince: null } };
    case "hibernate":
      return { ...plan, clearUnverified: true };
    case "gone":
    case "closed":
      return plan;
  }
}

function planLive(
  row: PlanRow,
  info: RuntimeInfo,
  ctx: PlanContext,
): UpdatePlan {
  if (info.dead) {
    if (row.status === "gone") return { kind: "noop" };
    return row.closeRequested
      ? { kind: "closed" }
      : { kind: "gone", stuckStartingMs: null };
  }

  // A held question: the agent is blocked on it, whatever its turn state says.
  const heldOpen = ctx.questionHold === "open";
  const live: LiveStatus = heldOpen
    ? { status: "waiting" }
    : liveStatusFor(info, ctx.lastSubmitAt, ctx.pendingTurnSince, ctx.now);
  const desired =
    live.status === "stuck" ? ({ status: "waiting" } as const) : live;
  const desiredWorkingOn =
    desired.status === "working" ? desired.workingOn : null;
  // Only adopt a new claudeSessionId once the shell's gate accepted it (a
  // transcript exists, in THIS conversation's own projects directory).
  const candidate = sessionCandidate(row, { kind: "live", info });
  const desiredSessionId =
    candidate && ctx.sessionAccepted ? candidate : row.claudeSessionId;
  const sessionChanged = desiredSessionId !== row.claudeSessionId;
  const statusChanged =
    desired.status !== row.status ||
    desiredWorkingOn !== (row.workingOn ?? null);
  const desiredWaitingFor = heldOpen
    ? QUESTION_WAITING_FOR
    : live.status === "stuck"
      ? STUCK_TURN_WAITING_FOR
      : null;
  const waitingForChanged =
    (desiredWaitingFor ?? null) !== (row.waitingFor ?? null);
  if (!sessionChanged && !statusChanged && !waitingForChanged)
    return { kind: "noop" };

  const patch: UpdateConversationPatch = {
    ...(statusChanged ? desired : {}),
    ...(sessionChanged ? { claudeSessionId: desiredSessionId } : {}),
    ...(waitingForChanged ? { waitingFor: desiredWaitingFor } : {}),
    // A live session on a `gone` row resurrects it.
    ...(row.status === "gone" ? { endedAt: null } : {}),
  };
  return {
    kind: "patch",
    patch,
    adoptedSessionId: sessionChanged ? desiredSessionId : null,
    ...(live.status === "stuck" && row.waitingFor !== STUCK_TURN_WAITING_FOR
      ? { stuckSince: live.since }
      : {}),
  };
}

function planAbsent(row: PlanRow, ctx: PlanContext): UpdatePlan {
  if (row.status === "gone") return { kind: "noop" };
  // Closed while starting: closed, whatever is still on its way (the spawn job
  // will not launch for a `done` row).
  if (row.status === "starting" && row.closeRequested)
    return { kind: "closed" };
  // A "starting" row whose spawn job is still coming has no session YET: the
  // job settles it — a live session the next reconcile adopts, or its last
  // failed attempt leaving it to the sweep below.
  if (row.status === "starting" && ctx.spawnInFlight) return { kind: "noop" };
  // Without a spawn job: a create running inline (fork, resume) inside the
  // grace window is normal — the runtime simply has no session to report yet.
  const startingAgeMs =
    row.status === "starting" ? ctx.now - row.createdAt.getTime() : null;
  if (startingAgeMs !== null && startingAgeMs < STARTING_TIMEOUT_MS)
    return { kind: "noop" };

  if (row.closeRequested) return { kind: "closed" };

  // Suspend-instead-of-gone: a resumable conversation whose process is missing
  // (idle-killed, lost to a reboot, or a resume that never came up) becomes
  // hibernated rather than gone — it keeps showing as a normal conversation and
  // is silently resumed on open. A missing process never moves a row to a
  // terminal status; only an explicit close (above) does. The reconciler NEVER clears `hibernatedAt` —
  // only `ensureResumed` does. See `decideMissingProcessAction` for why coupling
  // status to process absence deleted users' worktrees.
  //
  // The one status a missing process does settle is `working`: no process means
  // nothing is computing, and a row left at `working` reads as an agent busy
  // for hours (a session killed mid-turn, or mid-hook). It becomes `waiting` —
  // the status a hibernated conversation is meant to show — never a terminal
  // one, so the row stays active and its worktree is untouched. This is the
  // reconciler's call, not `decideMissingProcessAction`'s, which stays blind to
  // status so it can never write `gone` from it.
  //
  // A stuck row (`waiting` on a turn its agent never started) settles the same
  // way: with no process, nothing holds that turn any more.
  const endTurn =
    row.status === "working" || row.waitingFor === STUCK_TURN_WAITING_FOR;
  const action = decideMissingProcessAction(row, { onMain: ctx.onMain });
  switch (action) {
    case "hibernate":
      return { kind: "hibernate", endTurn };
    case "leave-hibernated":
      // Rows hibernated before `endTurn` existed (or by a path that skipped
      // it) still say `working`; settle them without re-stamping.
      return endTurn ? settleToWaiting() : { kind: "noop" };
    case "leave-unowned":
      return { kind: "noop" };
    case "gone":
      // Only an unresumable row reaches here. A "starting" row that got this
      // far never came up AND has no session to resume.
      return { kind: "gone", stuckStartingMs: startingAgeMs };
    // A future action must not silently inherit a `gone` — that is exactly how
    // process absence became a status write in the first place. Unhandled arms
    // are a compile error here, and loud at runtime.
    default: {
      const unhandled: never = action;
      throw new Error(`unhandled missing-process action: ${String(unhandled)}`);
    }
  }
}

function settleToWaiting(): UpdatePlan {
  return {
    kind: "patch",
    patch: { status: "waiting", waitingFor: null },
    adoptedSessionId: null,
  };
}
