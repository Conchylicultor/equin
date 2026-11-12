import {
  RETRYABLE_TURN_STATES,
  resumesStopped,
  turnIdKind,
  type TurnId,
  type TurnKind,
} from "@plugins/conversations/plugins/turn-ledger/core";
import {
  acceptTurn,
  applyTurnEvent,
  getTurn,
  hasTurnInFlight,
  hasTypedTurn,
  holdIfStarting,
  listHeldTurns,
  onStatusEvidence,
  returnHeldTurns,
  returnTurnByPromptUuid,
  type TurnRow,
} from "@plugins/conversations/plugins/turn-ledger/server";
import {
  QUESTION_WAITING_FOR,
  STUCK_TURN_WAITING_FOR,
} from "../../core/turn-gate";
import {
  ensureResumed,
  ResumeBlockedError,
  resumeIfStopped,
} from "./lifecycle";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import {
  conversationRuntime,
  withTerminal,
  type ConversationRuntime,
  type OutgoingTurn,
} from "./runtime";

// Every turn the app sends to an agent goes through here, and every one gets
// a row in the turn ledger (conversations/turn-ledger) first. The ledger says
// where the turn stands; the agent's own `turn_started` event says whether it
// went in. See research/2026-10-15-conversations-turn-ledger.md.
//
// A held turn — sent while its conversation was `starting` — is delivered by
// exactly one of two paths:
//
//   A. The launch message (spawn-job.ts → launchWithHeldTurn): the oldest held
//      turn is the launch prompt.
//   B. The flush once the agent can take input (deliver-held-turns-job.ts →
//      deliverHeldTurns), oldest first, through the ordinary verified send.
//
// Both claim a row with the `deliver` transition (held → typing, a conditional
// write only one claimant wins) and both run as the conversation's terminal
// writer (`withTerminal`), so the flush waits for the launch and never sees
// the launch's turn as still held. Path A carries one turn: one launch
// argument, one hook report.

/** A turn as a sender hands it in. */
export interface TurnSubmission {
  /** The client's id, which makes a retried request a no-op; minted when absent. */
  id?: TurnId;
  kind: TurnKind;
  /** What the user wrote, raw. */
  text: string;
  /**
   * What reaches the CLI (attachment refs resolved). For an `event`, the raw
   * body: the ledger types it inside the event envelope itself.
   */
  typedText: string;
}

export type SubmitOutcome =
  | { kind: "not-found" }
  /**
   * Nothing was recorded or typed: the conversation has no agent (`gone` /
   * `done`) and a turn of this kind does not bring it back (`resumesStopped`).
   */
  | { kind: "stopped"; status: "gone" | "done" }
  /** The ledger row as it stands after this call. */
  | { kind: "submitted"; turn: TurnRow };

/**
 * Record a turn and deliver it: held while the conversation is `starting`,
 * typed now otherwise. A stopped conversation (`gone` / `done`) is resumed by
 * a turn whose kind resumes it — the turn then waits, held, for the agent —
 * and refuses any other (`stopped`, nothing recorded). A request repeating an id the ledger already has
 * returns that row and types nothing. Throws when the delivery fails — the row
 * is `failed` by then, so the caller's error and the ledger agree.
 */
export async function submitTurn(
  conversationId: string,
  turn: TurnSubmission,
): Promise<SubmitOutcome> {
  const accepted = await acceptTurn(conversationId, {
    id: turn.id ?? turnIdKind.mint(),
    kind: turn.kind,
    text: turn.text,
    typedText: turn.typedText,
  });
  switch (accepted.kind) {
    case "not-found":
    case "stopped":
      return accepted;
    case "held":
    case "duplicate":
      return { kind: "submitted", turn: accepted.turn };
    case "send":
      return {
        kind: "submitted",
        turn: await withTerminal(conversationId, () =>
          deliverLocked(accepted.turn, {
            resumeStopped: resumesStopped(accepted.turn.kind),
          }),
        ),
      };
  }
}

export type RetryOutcome =
  | { kind: "not-found" }
  | { kind: "not-retryable"; turn: TurnRow }
  | { kind: "retried"; turn: TurnRow };

/**
 * Deliver a `failed` turn again, as it was typed. Manual only: re-sending is
 * the user's call. Throws when the delivery fails again (the row is `failed`).
 */
export async function retryTurn(
  conversationId: string,
  turnId: string,
): Promise<RetryOutcome> {
  return withTerminal(conversationId, async () => {
    const turn = await getTurn(turnId);
    if (turn?.conversationId !== conversationId) return { kind: "not-found" };
    if (!(RETRYABLE_TURN_STATES as readonly string[]).includes(turn.state)) {
      return { kind: "not-retryable", turn };
    }
    const claimed = await applyTurnEvent(turn.id, {
      kind: "deliver",
      typedText: turn.typedText,
    });
    if (claimed.state !== "typing")
      return { kind: "not-retryable", turn: claimed };
    return {
      kind: "retried",
      turn: await deliverLocked(claimed, {
        resumeStopped: resumesStopped(claimed.kind),
      }),
    };
  });
}

export type WithdrawOutcome =
  | { kind: "not-found" }
  /** The row as it stands: `withdrawn`, or the state that refused it. */
  | { kind: "withdrawn" | "not-withdrawable"; turn: TurnRow };

/**
 * The user took a `failed` turn back into the draft instead of retrying it
 * (the card's Copy to draft): the row becomes `withdrawn`, the draft its only
 * copy. Touches no agent.
 */
export async function withdrawTurn(
  conversationId: string,
  turnId: string,
): Promise<WithdrawOutcome> {
  const turn = await getTurn(turnId);
  if (turn?.conversationId !== conversationId) return { kind: "not-found" };
  const after = await applyTurnEvent(turn.id, { kind: "withdraw" });
  return {
    kind: after.state === "withdrawn" ? "withdrawn" : "not-withdrawable",
    turn: after,
  };
}

/**
 * Path B: deliver every held turn, oldest first. Each turn gets its own
 * verdict — a failure leaves that row `failed` (Retry) and the flush goes on to
 * the next — and the first failure is rethrown once all were tried, so the job
 * run reads as failed too.
 */
export async function deliverHeldTurns(conversationId: string): Promise<void> {
  await withTerminal(conversationId, async () => {
    let firstError: unknown = null;
    for (const held of await listHeldTurns(conversationId)) {
      const claimed = await applyTurnEvent(held.id, {
        kind: "deliver",
        typedText: held.typedText,
      });
      if (claimed.state !== "typing") continue;
      try {
        // Held turns wait for an agent coming up; one that stopped instead is
        // not brought back by its own flush.
        await deliverLocked(claimed, { resumeStopped: false });
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== null) throw firstError;
  });
}

/**
 * Path A. `launch` starts the session with the prompt it is handed: the oldest
 * held turn, if any, is the launch prompt. A launch that throws puts the turn
 * back to held: it never left.
 *
 * Call it only for a session that does not exist yet: a retry whose earlier
 * attempt already created the session must not, since `create` would no-op and
 * the claimed turn would never reach the agent.
 */
export async function launchWithHeldTurn(
  conversationId: string,
  launch: (prompt: OutgoingTurn | undefined) => Promise<void>,
): Promise<void> {
  await withTerminal(conversationId, async () => {
    const [first] = await listHeldTurns(conversationId);
    if (!first) {
      await launch(undefined);
      return;
    }
    const claimed = await applyTurnEvent(first.id, {
      kind: "deliver",
      typedText: first.typedText,
    });
    if (claimed.state !== "typing") {
      await launch(undefined);
      return;
    }
    try {
      await launch({ turnId: claimed.id, text: claimed.typedText });
    } catch (err) {
      await applyTurnEvent(first.id, {
        kind: "release",
        typedText: first.typedText,
      });
      throw err;
    }
    await applyTurnEvent(first.id, { kind: "typed" });
  });
}

/**
 * Stop: the runtime interrupts the turn and, when it got no reply, takes it
 * back out of the session (`ConversationRuntime.stop`). The web's draft
 * becomes the turn's only copy, and its ledger row is `returned`. Returns the
 * text taken back — the row's own text, the row named by the transcript line
 * the runtime took back.
 *
 * While the conversation is starting there is no turn running yet, only turns
 * waiting for the agent (`held` — the launch prompt, and whatever was sent
 * since): Stop takes those back at once, without waiting for the workspace or
 * the agent. The spawn goes on and the agent comes up idle, so the user edits
 * the prompt and sends it again. A launch message already riding the agent's
 * start (`typing` / `typed`) is stopped as a running turn, once the launch has
 * the terminal back.
 */
export async function stopTurn(conversationId: string): Promise<string | null> {
  const row = await getConversation(conversationId);
  if (!row) throw new Error(`Conversation ${conversationId} not found`);
  if (
    (row.status === "starting" || row.resumingSince !== null) &&
    !(await hasTurnInFlight(conversationId))
  ) {
    // Coming up with nothing on its way in: take every held turn back first,
    // racing the launch's claim (both conditional on `held`), then look again
    // — a launch that won the claim is stopped as a running turn below.
    const takenBack = await returnHeldTurns(conversationId);
    const stopped = (await hasTurnInFlight(conversationId))
      ? await stopRunningTurn(conversationId, row.waitingFor)
      : null;
    return joinStopTexts(stopped, takenBack);
  }
  return withTerminal(conversationId, async () => {
    const stopped = await stopRunningTurn(conversationId, row.waitingFor, {
      locked: true,
    });
    // As the terminal writer no launch or flush is claiming a held turn, so
    // taking them back here — after the wait, which may throw — is race-free
    // and loses none.
    return joinStopTexts(stopped, await returnHeldTurns(conversationId));
  });
}

/** Oldest first: the running turn was sent before any turn held behind it. */
function joinStopTexts(
  stopped: string | null,
  takenBack: readonly TurnRow[],
): string | null {
  const texts = [stopped, ...takenBack.map((turn) => turn.text)].filter(
    (text): text is string => text !== null && text.trim().length > 0,
  );
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * Stop the agent's running turn — first waiting for it to take a turn typed
 * into it ({@link awaitTypedTurnTaken}) — and return the text of the turn it
 * took back, or null when the turn stays (it had a reply, or there was none).
 */
async function stopRunningTurn(
  conversationId: string,
  waitingFor: string | null,
  { locked }: { locked: boolean } = { locked: false },
): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const { runtime } = await conversationRuntime(conversationId);
    // A stuck agent (its CLI wedged holding a turn) will never take it: stop
    // it as it stands rather than wait out the bound.
    if (waitingFor !== STUCK_TURN_WAITING_FOR)
      await awaitTypedTurnTaken(conversationId, runtime);
    const { returnedPromptUuid } = await runtime.stop(conversationId);
    if (returnedPromptUuid === null) return null;
    const returned = await returnTurnByPromptUuid(
      conversationId,
      returnedPromptUuid,
    );
    // Every turn an agent takes is a ledger row confirmed with its line's
    // uuid: one without a row is a ledger hole, and its text is gone from
    // the session — say so rather than hand back nothing.
    if (!returned) {
      throw new Error(
        `Stop took turn ${returnedPromptUuid} out of conversation ${conversationId}, but no ledger turn was confirmed as it`,
      );
    }
    return returned.text;
  };
  return locked ? run() : withTerminal(conversationId, run);
}

/**
 * How long Stop waits for an idle agent to take the turn typed into it — the
 * bound the sdk runtime gives an agent's start (its CLI's initialize), since
 * the turn waiting is usually the launch prompt riding that start.
 */
const TYPED_TURN_TAKE_MS = 60_000;

/** Stop waited out {@link TYPED_TURN_TAKE_MS} for a typed turn its agent never took. */
export class TypedTurnNotTakenError extends Error {
  constructor(conversationId: string) {
    super(
      `Stop: conversation ${conversationId}'s agent was handed a turn and neither took it nor gave it back within ${TYPED_TURN_TAKE_MS / 1000} s`,
    );
    this.name = "TypedTurnNotTakenError";
  }
}

/**
 * A turn typed into an agent that is not running one is about to start, but
 * has not yet: an interrupt now finds nothing to stop, and the turn then runs
 * in full (the Home tour's first request, stopped the second its agent came
 * up). Wait for the agent to take it (`accepted`) — or the ledger to settle it
 * otherwise (the agent went away: `dropped`) — so the interrupt that follows
 * stops it, and Stop's rewind hands it back. Push-based: re-read on each of
 * the ledger's status-evidence signals for this conversation. A turn queued
 * behind a running one is not waited for: the interrupt has a turn to stop.
 */
async function awaitTypedTurnTaken(
  conversationId: string,
  runtime: ConversationRuntime,
): Promise<void> {
  if (!(await hasTypedTurn(conversationId))) return;
  const inspection = (await runtime.inspect([conversationId])).get(
    conversationId,
  );
  if (
    inspection?.kind !== "live" ||
    inspection.info.dead ||
    inspection.info.workingOn === "turn"
  )
    return;
  let wake = (): void => {};
  const unsubscribe = onStatusEvidence((id) => {
    if (id === conversationId) wake();
  });
  try {
    await withDeadline(
      (async () => {
        for (;;) {
          // Armed before the read, so a signal landing during it is not lost.
          const signalled = new Promise<void>((resolve) => (wake = resolve));
          if (!(await hasTypedTurn(conversationId))) return;
          await signalled;
        }
      })(),
      TYPED_TURN_TAKE_MS,
      () => new TypedTurnNotTakenError(conversationId),
    );
  } finally {
    unsubscribe();
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Send one `typing` row to its agent and record that it is `typed`. The caller is
 * the conversation's terminal writer.
 *
 * A hibernated conversation is resumed first, which stamps `resumingSince`
 * (its status stays `waiting`); the row is then held like any turn sent while
 * the agent comes up, and the flush delivers it once the agent answers. A resume that is refused fails the
 * turn: falling through would send it to an agent that is not there.
 *
 * `resumeStopped`: a stopped (`gone` / `done`) conversation is resumed the
 * same way (Resume: status back to `starting`), and the row held for the flush.
 */
async function deliverLocked(
  turn: TurnRow,
  { resumeStopped }: { resumeStopped: boolean },
): Promise<TurnRow> {
  const conversationId = turn.conversationId;
  try {
    if (resumeStopped) await resumeIfStopped(conversationId);
    const resumed = await ensureResumed(conversationId);
    if (resumed.kind === "blocked") {
      throw new ResumeBlockedError(resumed.reason, resumed.message);
    }
    if (await holdIfStarting(turn.id)) {
      return (await getTurn(turn.id)) ?? turn;
    }
    await typeInto(turn);
  } catch (err) {
    await applyTurnEvent(turn.id, { kind: "failed", error: messageOf(err) });
    throw err;
  }
  return applyTurnEvent(turn.id, { kind: "typed" });
}

/**
 * Send the row's text. An answer goes through `answerPrompt` (withdraw the
 * question, then send). So does a turn sent while a question waits: the user
 * chose to say something else, and the agent would otherwise read it as the
 * answer.
 */
async function typeInto(turn: TurnRow): Promise<void> {
  const id = turn.conversationId;
  const { waitingFor, runtime } = await conversationRuntime(id);
  const outgoing: OutgoingTurn = { turnId: turn.id, text: turn.typedText };
  if (turn.kind === "answer" || waitingFor === QUESTION_WAITING_FOR)
    return runtime.answerPrompt(id, outgoing);
  return runtime.send(id, outgoing);
}
