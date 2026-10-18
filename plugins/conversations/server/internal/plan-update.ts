import type {
  Conversation,
  ConversationStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { UpdateConversationPatch } from "@plugins/tasks/plugins/tasks-core/server";
import {
  sameTerminalMenu,
  TERMINAL_MENU_WAITING_FOR,
} from "@plugins/conversations/plugins/terminal-menu/core";
import { decideMissingProcessAction } from "./hibernation-decision";
import type { RuntimeInfo } from "./runtime";
import type { QuestionHold } from "./question-hold";

// The status reconciler's decision, as a pure function of one conversation row
// and what its runtime says about it. Everything with an effect — the DB writes,
// the session-id gate's file reads, reports, the auto-open flush — stays in the
// shell (status-reconciler.ts), which applies the plan this returns.

/**
 * Grace window between insertConversation and the tmux pane becoming visible
 * to `list-panes`. Within this window, a "starting" row with no live session
 * is normal (worktree git fork, claude warmup). Past it, assume the runtime
 * never came up (crash mid-create, server restart, claude exited before the
 * first reconcile) and mark gone so the UI moves off "Starting…".
 */
export const STARTING_TIMEOUT_MS = 30_000;

/**
 * Pane titles that carry no information (e.g. the literal "Claude Code" the CLI
 * sets right after resume): read as "no title", so they never overwrite a
 * previously synthesised, meaningful one.
 */
export const UNINFORMATIVE_TITLES = [
  "Untitled",
  "Untitled conversation",
  "Claude Code",
];

/** The fields of a conversation row the decision reads. */
export type PlanRow = Pick<
  Conversation,
  | "status"
  | "closeRequested"
  | "title"
  | "claudeSessionId"
  | "waitingFor"
  | "waitingMenu"
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
   * The conversation's question held outside the pane (question-hold.ts), or
   * null when nothing holds one. Kept apart from the pane's own verdict
   * (`RuntimeInfo.waitingFor`): an `open` hold says a question is waiting
   * while NO menu is on screen, so it may set `waitingFor` but must never
   * trigger the auto-open flush — that sends Escape, which would cancel the
   * held call.
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
  /** A live session with no row in any status: adopt it (main only). */
  | { kind: "adopt"; status: ConversationStatus; title: string | null }
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
      /** An informative new title to carry onto the task. */
      taskTitle: string | null;
      /**
       * The pane's own menu just turned into a question that nothing holds —
       * the auto-open trigger. Never set by a held question: a held question
       * has no menu, and a released one is the menu the user asked for.
       */
      menuOpened: boolean;
    };

/**
 * Working when the CLI says so — or when it confirmed submitting a turn after
 * its last status write. The hook fires at Enter, before the CLI flips its
 * session file to busy, so an idle written BEFORE the submit is stale evidence;
 * one written after it (the turn ended, or was interrupted) is current. Causal
 * order, not a grace timer: a hook drained late still carries the CLI's moment.
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

/**
 * Decide what one reconcile writes for one conversation.
 *
 * `row` is null only when NO row exists in any status — the shell checks the
 * full table, so a terminal (`done`) conversation whose tmux session lingers is
 * never mistaken for an orphan.
 */
export function planConversationUpdate(
  row: PlanRow | null,
  live: Liveness,
  ctx: PlanContext,
): UpdatePlan {
  if (row === null) {
    // Orphan adoption is main-only: tmux is global (one server per host), so
    // every worktree backend sees every other worktree's sessions. Without this
    // guard each non-main worktree's DB would phantom-clone every conversation
    // it didn't spawn into its own task/attempt/conversation rows.
    if (!ctx.onMain || live.kind !== "live") return { kind: "noop" };
    const { info } = live;
    if (info.dead || !info.worktreePath) return { kind: "noop" };
    return {
      kind: "adopt",
      status: liveStatusFor(info, null),
      title: info.title || null,
    };
  }

  // "done" means a deliberate close (exit_clean / toolbar Exit) — never
  // overwrite it back to working/waiting just because the tmux session hasn't
  // been reaped yet.
  if (row.status === "done") return { kind: "noop" };

  switch (live.kind) {
    case "live":
      return planLive(row, live.info, ctx);
    case "unknown":
      // Runtime failed to answer (e.g. tmux unreachable under FD pressure). We
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

  const informativeNew =
    info.title && !UNINFORMATIVE_TITLES.includes(info.title);
  const desiredTitle = informativeNew ? info.title : row.title;
  // A held question: the agent is blocked on it, and the pane — showing no
  // menu — reads as an ordinary idle prompt (or, mid-hook, as busy).
  const heldOpen = ctx.questionHold === "open";
  const desiredStatus = heldOpen
    ? "waiting"
    : liveStatusFor(info, ctx.lastSubmitAt);
  const titleChanged = desiredTitle !== row.title;
  // Only adopt a new claudeSessionId once the shell's gate accepted it (a
  // transcript exists, in THIS conversation's own projects directory).
  const candidate = sessionCandidate(row, { kind: "live", info });
  const desiredSessionId =
    candidate && ctx.sessionAccepted ? candidate : row.claudeSessionId;
  const sessionChanged = desiredSessionId !== row.claudeSessionId;
  const statusChanged = desiredStatus !== row.status;
  // A terminal menu on screen is what the conversation waits on, whatever
  // the CLI's own (opaque) reason says: its key is derived here from the menu,
  // so `waitingFor` names the menu exactly while `waitingMenu` carries one.
  const desiredMenu =
    !heldOpen && desiredStatus === "waiting" ? info.menu : null;
  const desiredWaitingFor = heldOpen
    ? "question"
    : desiredMenu
      ? TERMINAL_MENU_WAITING_FOR
      : desiredStatus === "waiting"
        ? (info.waitingFor ?? null)
        : null;
  const waitingForChanged =
    (desiredWaitingFor ?? null) !== (row.waitingFor ?? null);
  const menuChanged = !sameTerminalMenu(desiredMenu, row.waitingMenu);
  if (
    !titleChanged &&
    !sessionChanged &&
    !statusChanged &&
    !waitingForChanged &&
    !menuChanged
  )
    return { kind: "noop" };

  const patch: UpdateConversationPatch = {};
  if (titleChanged) patch.title = desiredTitle;
  if (sessionChanged) patch.claudeSessionId = desiredSessionId;
  if (statusChanged) patch.status = desiredStatus;
  if (waitingForChanged) patch.waitingFor = desiredWaitingFor;
  if (menuChanged) patch.waitingMenu = desiredMenu;
  // A live session on a `gone` row resurrects it.
  if (row.status === "gone") patch.endedAt = null;
  return {
    kind: "patch",
    patch,
    adoptedSessionId: sessionChanged ? desiredSessionId : null,
    taskTitle:
      titleChanged &&
      desiredTitle &&
      !UNINFORMATIVE_TITLES.includes(desiredTitle)
        ? desiredTitle
        : null,
    // `desiredWaitingFor` is the pane's verdict whenever nothing holds.
    menuOpened:
      ctx.questionHold === null &&
      waitingForChanged &&
      desiredWaitingFor === "question",
  };
}

function planAbsent(row: PlanRow, ctx: PlanContext): UpdatePlan {
  if (row.status === "gone") return { kind: "noop" };
  // A "starting" row inside the grace window is normal (worktree checkout, DB
  // fork, claude warmup) — the pane simply isn't visible to `list-panes` yet.
  const startingAgeMs =
    row.status === "starting" ? ctx.now - row.createdAt.getTime() : null;
  if (startingAgeMs !== null && startingAgeMs < STARTING_TIMEOUT_MS)
    return { kind: "noop" };

  if (row.closeRequested) return { kind: "closed" };

  // Suspend-instead-of-gone: a resumable conversation whose process is missing
  // (idle-killed, lost to a reboot, or a resume that never came up) becomes
  // hibernated rather than gone — it keeps showing as a normal conversation and
  // is silently resumed on open. A missing pane never moves a row to a
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
    taskTitle: null,
    menuOpened: false,
  };
}
