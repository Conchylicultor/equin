import { and, asc, desc, eq, gte, inArray, max } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import {
  _conversations,
  getConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import { turnIdKind, type TurnId } from "../../core/id-kind";
import type { TurnKind } from "../../core/schemas";
import { _conversationTurns } from "./tables";
import { userTurnSent } from "./tables-user-turn-sent-event";
import {
  CONFIRMABLE_STATES,
  promptCandidates,
  transitionTurn,
  type TurnEvent,
} from "./transition";
import { reportTurnMerged, reportTurnUnverified } from "./report-kinds";
import { notifyTurnSubmitted } from "./submit-signal";

/** One ledger row, as the server holds it. */
export type TurnRow = typeof _conversationTurns.$inferSelect;

/** A turn about to enter the ledger. */
export interface NewTurn {
  id: TurnId;
  kind: TurnKind;
  text: string;
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
        typedText: turn.typedText,
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
  if (!next) return { row, changed: false };
  const [updated] = await tx
    .update(_conversationTurns)
    .set({ state: next.state, ...next.patch })
    .where(eq(_conversationTurns.id, turnIdKind.key(turnId)))
    .returning();
  return { row: updated!, changed: true };
}

/**
 * Whether this change is the moment the agent got a user's message, the fact
 * `conversation.userTurnSent` announces: the agent confirmed it (accepted or
 * merged).
 */
function deliveredNow({ row }: Applied): boolean {
  return (
    row.kind === "turn" && (row.state === "accepted" || row.state === "merged")
  );
}

/** What a change means beyond the row: the event, and its report. */
async function afterChange(applied: Applied): Promise<void> {
  if (!applied.changed) return;
  const { row } = applied;
  if (deliveredNow(applied)) {
    const conversation = await getConversation(row.conversationId);
    if (conversation) {
      await userTurnSent.emit({
        conversationId: row.conversationId,
        taskId: conversation.taskId,
        text: row.text,
      });
    }
  }
  if (row.state === "merged") await reportTurnMerged(row);
  if (row.state === "unverified") await reportTurnUnverified(row);
}

/**
 * Apply `event` to the turn — the ONLY way a ledger state changes. Locks the
 * row, asks {@link transitionTurn}, writes its answer, then announces it
 * (`userTurnSent`, the merged / unverified reports). Returns the row as it now
 * stands; an event that does not apply leaves it untouched.
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

/**
 * Resolve the turn the CLI just reported submitting at `at`: the first of
 * {@link promptCandidates} the confirmation still applies to. A prompt matching
 * nothing — typed in the terminal, the launch's own task prompt — is not ours.
 * Returns the resolved row, or null. A resolved row signals
 * `onTurnSubmitted`.
 */
export async function resolvePromptSubmit(
  conversationId: string,
  prompt: string,
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
  for (const candidate of promptCandidates(prompt, oldestFirst)) {
    const applied = await conn.transaction((tx) =>
      applyInTx(tx, candidate.id, { kind: "confirmed", prompt, at }),
    );
    await afterChange(applied);
    if (applied.changed) {
      notifyTurnSubmitted(conversationId);
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
        inArray(_conversationTurns.state, ["typed", "accepted", "merged"]),
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
 * Mark `returned` the newest delivered turn whose text the CLI handed back —
 * the text Stop rewound, or a draft found in the input box before typing. The
 * text compared is what the CLI submitted (a merged row's whole prompt).
 * Returns the row, or null when no recent turn carries that text.
 */
export async function returnTurnByText(
  conversationId: string,
  text: string,
  conn: NodePgDatabase = db,
): Promise<TurnRow | null> {
  const wanted = text.trim();
  if (wanted.length === 0) return null;
  const recent = await conn
    .select()
    .from(_conversationTurns)
    .where(
      and(
        eq(_conversationTurns.conversationId, conversationId),
        inArray(_conversationTurns.state, ["typed", "accepted", "merged"]),
      ),
    )
    .orderBy(desc(_conversationTurns.createdAt), desc(_conversationTurns.id))
    .limit(10);
  const match = recent.find(
    (row) => (row.submittedText ?? row.typedText).trim() === wanted,
  );
  if (!match) return null;
  return applyTurnEvent(match.id, { kind: "returned" }, conn);
}
