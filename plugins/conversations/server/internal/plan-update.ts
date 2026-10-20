import type {
  Conversation,
  ConversationStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { UpdateConversationPatch } from "@plugins/tasks/plugins/tasks-core/server";
import { decideMissingProcessAction } from "./hibernation-decision";
import type { RuntimeInfo } from "./runtime";
import type { QuestionHold } from "./question-hold";

// The status reconciler's decision, as a pure function of one conversation row
// and what its runtime says about it. Everything with an effect — the DB writes,
// the session-id gate's file reads, reports, the auto-open flush — stays in the
// shell (status-reconciler.ts), which applies the plan this returns.

/**
 * Grace window between insertConversation and the runtime reporting a live
 * session. Within this window, a "starting" row with no live session is normal
 * (worktree git fork, agent warmup). Past it, assume the runtime never came up
 * (crash mid-create, server restart, the agent exited before the first
 * reconcile) and mark gone so the UI moves off "Starting…".
 */
export const STARTING_TIMEOUT_MS = 30_000;

/** The fields of a conversation row the decision reads. */
export type PlanRow = Pick<
  Conversation,
  | "status"
  | "closeRequested"
  | "claudeSessionId"
  | "waitingFor"
  | "createdAt"
  | "hibernatedAt"
>;

/** What the runtime says about one conversation. */
export type Liveness =
  /** A live (or dead-but-listed) session. */
  | { kind: "live"; info: RuntimeInfo }
  /** The runtime answered and has no session for it. */
  | { kind: "absent" }
  /** The runtime failed to answer — its state is unknown. */
  | { kind: "unknown" };

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
  | { kind: "hibernate"; endTurn: boolean }
  | {
      kind: "patch";
      patch: UpdateConversationPatch;
      /** A new session id to append to the chain (behind the gate). */
      adoptedSessionId: string | null;
    };

/**
 * Working when the runtime says so — or when the turn ledger confirmed a turn
 * submitted after the runtime's last status write: an idle written BEFORE the
 * submit is stale evidence; one written after it (the turn ended, or was
 * interrupted) is current. Causal order, not a grace timer.
 */
export function liveStatusFor(
  info: RuntimeInfo,
  lastSubmitAt: Date | null,
): ConversationStatus {
  if (info.working) return "working";
  const submittedSince =
    lastSubmitAt !== null &&
    info.statusWrittenAt !== null &&
    lastSubmitAt > info.statusWrittenAt;
  return submittedSince ? "working" : "waiting";
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
      return planLive(row, live.info, ctx);
    case "unknown":
      // Runtime failed to answer (e.g. a socket error under FD pressure). We
      // can't tell whether the session is alive, so leave status alone and wait
      // for a reconcile where the runtime answers — better than declaring every
      // working/waiting conversation gone on a transient hiccup.
      return { kind: "noop" };
    case "absent":
      return planAbsent(row, ctx);
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
  const desiredStatus = heldOpen
    ? "waiting"
    : liveStatusFor(info, ctx.lastSubmitAt);
  // Only adopt a new claudeSessionId once the shell's gate accepted it (a
  // transcript exists, in THIS conversation's own projects directory).
  const candidate = sessionCandidate(row, { kind: "live", info });
  const desiredSessionId =
    candidate && ctx.sessionAccepted ? candidate : row.claudeSessionId;
  const sessionChanged = desiredSessionId !== row.claudeSessionId;
  const statusChanged = desiredStatus !== row.status;
  const desiredWaitingFor = heldOpen ? "question" : null;
  const waitingForChanged =
    (desiredWaitingFor ?? null) !== (row.waitingFor ?? null);
  if (!sessionChanged && !statusChanged && !waitingForChanged)
    return { kind: "noop" };

  const patch: UpdateConversationPatch = {};
  if (sessionChanged) patch.claudeSessionId = desiredSessionId;
  if (statusChanged) patch.status = desiredStatus;
  if (waitingForChanged) patch.waitingFor = desiredWaitingFor;
  // A live session on a `gone` row resurrects it.
  if (row.status === "gone") patch.endedAt = null;
  return {
    kind: "patch",
    patch,
    adoptedSessionId: sessionChanged ? desiredSessionId : null,
  };
}

function planAbsent(row: PlanRow, ctx: PlanContext): UpdatePlan {
  if (row.status === "gone") return { kind: "noop" };
  // A "starting" row inside the grace window is normal (worktree checkout, DB
  // fork, agent warmup) — the runtime simply has no session to report yet.
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
  const endTurn = row.status === "working";
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
