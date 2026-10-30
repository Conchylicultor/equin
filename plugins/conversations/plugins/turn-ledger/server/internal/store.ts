import { and, asc, eq, gte, inArray, lt, lte, max } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import {
  _conversations,
  getConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import { turnIdKind, type TurnId } from "../../core";
import { typedTextOf } from "../../core";
import type { TurnKind, TurnState } from "../../core";
import { _conversationTurns } from "./tables";
import { userTurnSent } from "./tables-user-turn-sent-event";
import {
  CONFIRMABLE_STATES,
  promptIs,
  transitionTurn,
  type TurnEvent,
} from "./transition";
import { notifyStatusEvidence } from "./status-evidence-signal";

/** One ledger row, as the server holds it. */
export type TurnRow = typeof _conversationTurns.$inferSelect;

/** A turn about to enter the ledger. */
export interface NewTurn {
  id: TurnId;
  kind: TurnKind;
  text: string;
  /** What reaches the CLI — for an `event`, its raw body (the accept wraps it). */
  typedText: string;
}

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/** What the accept decided for one turn. */
export type AcceptOutcome =
  | { kind: "not-found" }
  /** Kept as `held`: the conversation is still `starting`. */
  | { kind: "held"; turn: TurnRow }
  /** Recorded as `typing`: the caller delivers it now. */
  | { kind: "send"; turn: TurnRow }
  /** A row with this id exists already — a retried request; nothing to do. */
  | { kind: "duplicate"; turn: TurnRow };

/**
 * Record a turn, held when the conversation is still `starting` and otherwise
 * `typing` for the caller to deliver.
 *
 * The conversation ROW lock is what the held-turn paths' correctness rests on:
 * every status flip out of `starting` is an UPDATE of that row, so it
 * serializes behind the accept — a turn is either held before the flip (and the
 * flush the reconciler enqueues AFTER its write sees it), or the accept sees the
 * new status and sends directly. No turn can be held after the last flush
 * looked. The send itself happens after this commits: it can write the row (a
 * hibernated conversation resumes first), and holding the lock across that
 * would wait on itself.
 *
 * The id is the client's: a second request with it finds the row the first one
 * wrote and changes nothing, which is what makes the endpoints idempotent.
 */
export async function acceptTurn(
  conversationId: string,
  turn: NewTurn,
  conn: NodePgDatabase = db,
): Promise<AcceptOutcome> {
  return conn.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ status: _conversations.status })
      .from(_conversations)
      .where(eq(_conversations.id, conversationId))
      .for("update");
    if (!conversation) return { kind: "not-found" };
    const held = conversation.status === "starting";
    const [inserted] = await tx
      .insert(_conversationTurns)
      .values({
        id: turn.id,
        conversationId,
        kind: turn.kind,
        text: turn.text,
        // An `event` is typed inside its envelope — applied here, the one
        // door every turn enters by, so no sender can deliver one bare.
        typedText: typedTextOf(turn.kind, turn.typedText),
        state: held ? "held" : "typing",
      })
      .onConflictDoNothing({ target: _conversationTurns.id })
      .returning();
    if (inserted) return { kind: held ? "held" : "send", turn: inserted };
    const [existing] = await tx
      .select()
      .from(_conversationTurns)
      .where(eq(_conversationTurns.id, turn.id));
    if (existing?.conversationId !== conversationId) {
      throw new Error(
        `turn ${turn.id} already belongs to conversation ${existing?.conversationId ?? "<none>"}, not ${conversationId}`,
      );
    }
    return { kind: "duplicate", turn: existing };
  });
}

/**
 * Hold a `typing` turn when its conversation is `starting` — a resume put it
 * there between the accept and the send. Same row lock as {@link acceptTurn},
 * for the same reason: held before the flip out of `starting`, or not at all.
 * Returns whether it was held.
 */
export async function holdIfStarting(
  turnId: string,
  conn: NodePgDatabase = db,
): Promise<boolean> {
  return conn.transaction(async (tx) => {
    const [turn] = await tx
      .select({ conversationId: _conversationTurns.conversationId })
      .from(_conversationTurns)
      .where(eq(_conversationTurns.id, turnIdKind.key(turnId)));
    if (!turn) throw new Error(`turn ${turnId} not found`);
    const [conversation] = await tx
      .select({ status: _conversations.status })
      .from(_conversations)
      .where(eq(_conversations.id, turn.conversationId))
      .for("update");
    if (conversation?.status !== "starting") return false;
    const applied = await applyInTx(tx, turnId, { kind: "hold" });
    return applied.changed;
  });
}

export async function getTurn(
  turnId: string,
  conn: Pick<NodePgDatabase, "select"> = db,
): Promise<TurnRow | null> {
  const [row] = await conn
    .select()
    .from(_conversationTurns)
    .where(eq(_conversationTurns.id, turnIdKind.key(turnId)));
  return row ?? null;
}

interface Applied {
  row: TurnRow;
  /** The state before the event. */
  was: TurnState;
  changed: boolean;
}

async function applyInTx(
  tx: Tx,
  turnId: string,
  event: TurnEvent,
): Promise<Applied> {
  const [row] = await tx
    .select()
    .from(_conversationTurns)
    .where(eq(_conversationTurns.id, turnIdKind.key(turnId)))
    .for("update");
  if (!row) throw new Error(`turn ${turnId} not found`);
  const next = transitionTurn(row, event);
  if (!next) return { row, was: row.state, changed: false };
  const [updated] = await tx
    .update(_conversationTurns)
    .set({ state: next.state, ...next.patch })
    .where(eq(_conversationTurns.id, turnIdKind.key(turnId)))
    .returning();
  return { row: updated!, was: row.state, changed: true };
}

/**
 * What a change means beyond the row: the status reconciler's evidence moved
 * when the row entered or left a pending state; `conversation.userTurnSent`
 * when it is the moment the agent got a user's message — it confirmed a
 * `turn` row.
 */
async function afterChange(applied: Applied): Promise<void> {
  if (!applied.changed) return;
  const { row } = applied;
  if (isPending(applied.was) !== isPending(row.state))
    notifyStatusEvidence(row.conversationId);
  if (row.kind !== "turn" || row.state !== "accepted") return;
  const conversation = await getConversation(row.conversationId);
  if (conversation) {
    await userTurnSent.emit({
      conversationId: row.conversationId,
      taskId: conversation.taskId,
      text: row.text,
    });
  }
}

/**
 * Apply `event` to the turn — the ONLY way a ledger state changes. Locks the
 * row, asks {@link transitionTurn}, writes its answer, then announces it
 * (`userTurnSent`). Returns the row as it now stands; an event that does not
 * apply leaves it untouched.
 */
export async function applyTurnEvent(
  turnId: string,
  event: TurnEvent,
  conn: NodePgDatabase = db,
): Promise<TurnRow> {
  const applied = await conn.transaction((tx) => applyInTx(tx, turnId, event));
  await afterChange(applied);
  return applied.row;
}

/** The conversation's held turns, oldest first — the order they were accepted. */
export async function listHeldTurns(
  conversationId: string,
  conn: Pick<NodePgDatabase, "select"> = db,
): Promise<TurnRow[]> {
  return conn
    .select()
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        eq(_conversationTurns.state, "held"),
      ),
    )
    .orderBy(asc(_conversationTurns.createdAt), asc(_conversationTurns.id));
}

export async function hasHeldTurns(
  conversationId: string,
  conn: Pick<NodePgDatabase, "select"> = db,
): Promise<boolean> {
  const [row] = await conn
    .select({ id: _conversationTurns.id })
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        eq(_conversationTurns.state, "held"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** What the agent's confirmation of one turn found. */
export type ConfirmOutcome =
  /** The row is `accepted` now. */
  | { kind: "confirmed"; turn: TurnRow }
  /** The row was settled already (a replayed line, or Stop got there first): unchanged. */
  | { kind: "settled"; turn: TurnRow }
  /** No row has the id. */
  | { kind: "unknown-turn" }
  /** The row is another conversation's. Unchanged. */
  | { kind: "other-conversation"; owner: string };

/**
 * The agent took turn `turnId` (its `turn_started` echoed the id the turn was
 * sent with), as the transcript line `promptUuid`, at `at`: THAT row becomes
 * `accepted` — the `confirmed` event, whatever the row's state short of
 * settled. A row already settled is left as it is, so replaying the line
 * changes nothing. A confirmed row signals `onStatusEvidence` and announces
 * `userTurnSent`.
 *
 * An id no row has, or another conversation's, is a fact the caller reports:
 * the ledger does not guess which row it meant.
 */
export async function confirmTurn(
  conversationId: string,
  turnId: string,
  promptUuid: string,
  at: Date,
  conn: NodePgDatabase = db,
): Promise<ConfirmOutcome> {
  const found = await conn.transaction(
    async (
      tx,
    ): Promise<
      | Extract<ConfirmOutcome, { kind: "unknown-turn" | "other-conversation" }>
      | { kind: "applied"; applied: Applied }
    > => {
      const [owner] = await tx
        .select({ conversationId: _conversationTurns.conversationId })
        .from(_conversationTurns)
        .where(eq(_conversationTurns.id, turnIdKind.key(turnId)))
        .for("update");
      if (!owner) return { kind: "unknown-turn" };
      if (owner.conversationId !== conversationId) {
        return { kind: "other-conversation", owner: owner.conversationId };
      }
      const applied = await applyInTx(tx, turnId, {
        kind: "confirmed",
        promptUuid,
        at,
      });
      return { kind: "applied", applied };
    },
  );
  if (found.kind !== "applied") return found;
  const { applied } = found;
  await afterChange(applied);
  if (!applied.changed) return { kind: "settled", turn: applied.row };
  notifyStatusEvidence(conversationId);
  return { kind: "confirmed", turn: applied.row };
}

/**
 * TEMPORARY. Resolve the turn the agent reported taking at `at` WITHOUT an id
 * — an agent started before turn ids, whose launch prompt carries none: the
 * oldest unsettled row whose typed text IS the prompt (`promptIs`, equality
 * only). A prompt matching no row is not resolved. Returns the resolved row,
 * or null. A resolved row signals `onStatusEvidence`.
 *
 * Deleted, with `confirmed-by-text`, once no agent started before turn ids
 * runs — no live `conversations_ext_sdk_agent` row with `turn_ids` false
 * ({@link confirmTurn} is the path).
 */
export async function resolvePromptSubmit(
  conversationId: string,
  prompt: string,
  promptUuid: string,
  at: Date,
  conn: NodePgDatabase = db,
): Promise<TurnRow | null> {
  const oldestFirst = await conn
    .select()
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        inArray(_conversationTurns.state, CONFIRMABLE_STATES),
      ),
    )
    .orderBy(asc(_conversationTurns.createdAt), asc(_conversationTurns.id));
  for (const candidate of oldestFirst.filter((row) =>
    promptIs(prompt, row.typedText),
  )) {
    const applied = await conn.transaction((tx) =>
      applyInTx(tx, candidate.id, {
        kind: "confirmed-by-text",
        prompt,
        promptUuid,
        at,
      }),
    );
    await afterChange(applied);
    if (applied.changed) {
      notifyStatusEvidence(conversationId);
      return applied.row;
    }
  }
  return null;
}

/**
 * When the CLI last confirmed submitting a turn, per conversation (absent: it
 * never did). The status reconciler's evidence that an agent is working even
 * while its session file still reads idle — see `liveStatusFor`.
 */
export async function latestSubmitAt(
  conversationIds: readonly string[],
  conn: Pick<NodePgDatabase, "select"> = db,
): Promise<Map<string, Date>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await conn
    .select({
      conversationId: _conversationTurns.conversationId,
      at: max(_conversationTurns.submittedAt),
    })
    .from(_conversationTurns)
    .where(inArray(_conversationTurns.conversationId, [...conversationIds]))
    .groupBy(_conversationTurns.conversationId);
  return new Map(
    rows.flatMap((row) => (row.at ? [[row.conversationId, row.at]] : [])),
  );
}

/**
 * The states of a turn the agent will start with nobody doing anything more:
 * `typing` (being sent — the launch prompt while its agent comes up) and
 * `typed` (in its CLI's queue, started at the next tool boundary or the turn's
 * end). Each leaves only by an event — the agent's confirmation, a failure,
 * the agent going away or a new one starting (`dropped`), Stop, a restart of
 * the sender (`failOrphanedTypingTurns`) — never a timer. Not `held`: that
 * turn waits for a flush which may never come (`held-turn-undelivered`), so it
 * is no evidence the agent will run.
 */
const PENDING_TURN_STATES = [
  "typing",
  "typed",
] as const satisfies readonly TurnState[];

function isPending(state: TurnState): boolean {
  return (PENDING_TURN_STATES as readonly TurnState[]).includes(state);
}

/**
 * The conversations of `conversationIds` holding a turn their agent has not
 * started yet but will on its own ({@link PENDING_TURN_STATES}). The status
 * reconciler's evidence that an agent between turns is not at rest: its
 * launch prompt while its CLI boots, a turn queued behind a turn that just
 * ended — see `liveStatusFor`. A row leaving these states signals
 * `onStatusEvidence`, so the status follows it.
 */
export async function conversationsWithPendingTurn(
  conversationIds: readonly string[],
  conn: Pick<NodePgDatabase, "selectDistinct"> = db,
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const rows = await conn
    .selectDistinct({ conversationId: _conversationTurns.conversationId })
    .from(_conversationTurns)
    .where(
      and(
        inArray(_conversationTurns.conversationId, [...conversationIds]),
        inArray(_conversationTurns.state, [...PENDING_TURN_STATES]),
      ),
    );
  return new Set(rows.map((row) => row.conversationId));
}

/**
 * Fail every turn still `typing` since before `bootedAt`: the process sending
 * it died mid-send (a backend restart), so nothing will ever record its
 * verdict, and it would read as a turn the agent is about to start forever.
 * Failed is the honest verdict — Retry; a confirmation still wins if the agent
 * did take it. Returns how many it failed.
 */
export async function failOrphanedTypingTurns(
  bootedAt: Date,
  conn: NodePgDatabase = db,
): Promise<number> {
  const orphans = await conn
    .select({ id: _conversationTurns.id })
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.state, "typing"),
        lt(_conversationTurns.updatedAt, bootedAt),
      ),
    );
  let failed = 0;
  for (const { id } of orphans) {
    const row = await applyTurnEvent(
      id,
      {
        kind: "failed",
        error:
          "The backend restarted while sending it, so it may never have reached the agent.",
      },
      conn,
    );
    if (row.state === "failed") failed++;
  }
  return failed;
}

/**
 * Mark `returned` every delivered turn sent at or after `since` — the turns a
 * rewind cut out of the transcript. Returns them.
 */
export async function returnTurnsSince(
  conversationId: string,
  since: Date,
  conn: NodePgDatabase = db,
): Promise<TurnRow[]> {
  const cut = await conn
    .select({ id: _conversationTurns.id })
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        inArray(_conversationTurns.state, ["typed", "accepted"]),
        gte(_conversationTurns.createdAt, since),
      ),
    )
    .orderBy(asc(_conversationTurns.createdAt), asc(_conversationTurns.id));
  const returned: TurnRow[] = [];
  for (const { id } of cut) {
    returned.push(await applyTurnEvent(id, { kind: "returned" }, conn));
  }
  return returned;
}

/**
 * Fail every turn still `typed` that was sent before `exitedAt` — the agent
 * went away with it in its CLI's queue, so it never ran. A turn sent after the
 * exit went to the agent that replaced it and is left alone.
 */
export async function dropTypedTurns(
  conversationId: string,
  exitedAt: Date,
  conn: NodePgDatabase = db,
): Promise<TurnRow[]> {
  const waiting = await conn
    .select({ id: _conversationTurns.id })
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        eq(_conversationTurns.state, "typed"),
        lte(_conversationTurns.createdAt, exitedAt),
      ),
    )
    .orderBy(asc(_conversationTurns.createdAt), asc(_conversationTurns.id));
  const dropped: TurnRow[] = [];
  for (const { id } of waiting) {
    const row = await applyTurnEvent(id, { kind: "dropped" }, conn);
    if (row.state === "failed") dropped.push(row);
  }
  return dropped;
}

/**
 * Mark `returned` every held turn — Stop while the conversation is starting:
 * none of them reached the agent, so the web draft takes them back and the
 * agent comes up with nothing to answer. Each write is conditional on `held`,
 * like the `deliver` claim of the launch and the flush, so a turn being
 * claimed at this moment is either taken back whole or delivered whole.
 * Returns the turns taken back, oldest first.
 */
export async function returnHeldTurns(
  conversationId: string,
  conn: NodePgDatabase = db,
): Promise<TurnRow[]> {
  const returned: TurnRow[] = [];
  for (const held of await listHeldTurns(conversationId, conn)) {
    const row = await applyTurnEvent(held.id, { kind: "returned" }, conn);
    if (row.state === "returned") returned.push(row);
  }
  return returned;
}

/**
 * Whether a turn is on its way into the agent: claimed for delivery
 * (`typing`), or typed and not confirmed yet (`typed`). While the conversation
 * is starting, such a turn is the launch message riding the agent's start.
 */
export async function hasTurnInFlight(
  conversationId: string,
  conn: Pick<NodePgDatabase, "select"> = db,
): Promise<boolean> {
  const [row] = await conn
    .select({ id: _conversationTurns.id })
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        inArray(_conversationTurns.state, ["typing", "typed"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Mark `returned` the turn the agent took as transcript line `promptUuid` —
 * the turn Stop took back out of the session, or the message a rewind cut at.
 * Returns the row, or null when this conversation has no turn with that uuid
 * (a turn confirmed before the ledger recorded uuids).
 */
export async function returnTurnByPromptUuid(
  conversationId: string,
  promptUuid: string,
  conn: NodePgDatabase = db,
): Promise<TurnRow | null> {
  const [match] = await conn
    .select({ id: _conversationTurns.id })
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        eq(_conversationTurns.promptUuid, promptUuid),
      ),
    );
  if (!match) return null;
  return applyTurnEvent(match.id, { kind: "returned" }, conn);
}
