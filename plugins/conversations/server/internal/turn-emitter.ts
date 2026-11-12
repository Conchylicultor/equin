import { sql } from "drizzle-orm";
import { z } from "zod";
import { isActiveStatus } from "../../core";
import {
  getConversationRuntime,
  listConversationsForInfra,
} from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  readJsonlEventsFromChain,
  resolveConversationTranscriptPaths,
  watchTranscriptAppends,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  createTurnEndTracker,
  type TurnEnd,
} from "@plugins/conversations/plugins/transcript-source/core";
import {
  _conversationTurnCompletedTriggers,
  conversationTurnCompleted,
} from "./tables-turn-completed-event";
import { databaseForkedAt } from "@plugins/database/plugins/fork-point/server";
import { isOwnConversation } from "./conversation-ownership";

// conversationId → unsubscribe
const subscriptions = new Map<string, () => void>();

// Every reconcile — the boot one and each per-conversation one — runs through
// this one-at-a-time gate and reads the DB inside its turn. Otherwise the boot
// read could see X active, X→done's reconcile unsubscribe it, and boot then
// resubscribe X from its stale read. Serialized, the last writer is always the
// freshest read. A failing turn rejects its own caller and frees the gate.
const reconcileGate = createSemaphore(1);

// Followed: an active conversation of this database's own. One a fork copied
// in from main's is main's to follow, whatever its status says here — see
// `isOwnConversation`.
//
// Converges one conversation's subscription on its current DB status. The
// event that woke it is only a wake-up: out-of-order, duplicate or replayed
// events all land on the same truth.
function reconcile(conversationId: string): Promise<void> {
  return reconcileGate.run(async () => {
    const row = await getConversationRuntime(conversationId);
    const forkedAt = await databaseForkedAt();
    const active =
      row !== null &&
      isActiveStatus(row.status) &&
      isOwnConversation(row, forkedAt);
    const unsub = subscriptions.get(conversationId);
    if (active && !unsub) {
      subscriptions.set(
        conversationId,
        subscribeToConversation(conversationId),
      );
    } else if (!active && unsub) {
      unsub();
      subscriptions.delete(conversationId);
    }
  });
}

// Boot reconcile: subscriptions live in memory, so every restart rebuilds them
// from one read. A transition missed while the process was down is caught here
// too. Fails loudly — there is no later tick to retry.
export function startTurnEmitter(): Promise<void> {
  return reconcileGate.run(async () => {
    const convs = await listConversationsForInfra();
    const forkedAt = await databaseForkedAt();
    for (const c of convs) {
      if (
        !isActiveStatus(c.status) ||
        !isOwnConversation(c, forkedAt) ||
        subscriptions.has(c.id)
      )
        continue;
      subscriptions.set(c.id, subscribeToConversation(c.id));
    }
  });
}

// Woken by conversation.created and conversation.statusChanged (see the
// Trigger contributions in the plugin barrel).
export const turnEmitterReconcileJob = defineJob({
  name: "conversations.turn-emitter.reconcile",
  description:
    "Starts or stops following a conversation's transcript as it becomes active or ends, so a finished agent turn is announced to whatever waits on it.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ conversationId: z.string() }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    await reconcile(event.conversationId);
  },
});

// Follows one active conversation from NOW: a turn is announced when it ends
// after the subscription (the backend's boot or the conversation becoming
// active). Subscribing reads no history — only the transcript's appends, and
// a backward read of each chain file's last assistant message, the context a
// turn whose Stop hooks are still running needs. A turn that ended while the
// backend was down is not announced, as before — except to a durable workflow
// still waiting on this conversation, which gets the latest one replayed.
function subscribeToConversation(conversationId: string): () => void {
  const tracker = createTurnEndTracker();
  // Turns this subscription announced: the waiter replay and the append stream
  // can both reach the latest turn.
  const announced = new Set<string>();
  let emitting = Promise.resolve();
  const announce = (turn: TurnEnd) => {
    if (announced.has(turn.messageId)) return;
    announced.add(turn.messageId);
    emitting = emitting.then(() =>
      runTracked("conversations:turn-emitter-events", () =>
        emitEndTurn(conversationId, turn),
      ),
    );
  };

  const unsubscribe = watchTranscriptAppends(
    conversationId,
    lastAssistantMessage,
    ({ lines }) => {
      // A turn is over once its Stop hooks let the agent stop — not at the
      // `end_turn` text, which the CLI writes BEFORE running them: a waiter that
      // tears the agent down on that text (exit_clean's finalize) killed the
      // stop gate mid-run, and a stop a hook blocked is no end at all.
      // Seed lines were written before this subscription: they only set up
      // the turn in progress, and a turn they end was over before it.
      for (const { line, seed } of lines) {
        const ended = tracker.feed(line);
        if (ended && !seed) announce(ended);
      }
    },
  );
  void runTracked("conversations:turn-emitter-replay", () =>
    replayForWaiter(conversationId, announce),
  );
  return unsubscribe;
}

/**
 * The backward read of a file met for the first time: its lines back to the
 * newest assistant message, that message's lines included — so a turn whose
 * last message was written but whose Stop hooks have not answered is known.
 */
function lastAssistantMessage(): (
  line: Record<string, unknown>,
) => "take" | "stop" {
  let newest: unknown = undefined;
  return (line) => {
    if (line.type !== "assistant") return "take";
    const id = (line.message as { id?: unknown } | undefined)?.id;
    if (newest === undefined) {
      newest = id ?? null;
      return "take";
    }
    return id === newest ? "take" : "stop";
  };
}

/**
 * A durable workflow waiting on this conversation (a trigger row keyed to it)
 * may have missed its turn while the backend was down: hand it the latest
 * finished turn. Only for a waited-on conversation — the one case a boot reads
 * the whole transcript.
 */
async function replayForWaiter(
  conversationId: string,
  announce: (turn: TurnEnd) => void,
): Promise<void> {
  if (!(await hasPendingTrigger(conversationId))) return;
  const events = await readJsonlEventsFromChain(
    await resolveConversationTranscriptPaths(conversationId),
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (
      e.kind === "assistant-text" &&
      e.stopReason === "end_turn" &&
      e.stopHooks === "allowed" &&
      typeof e.messageId === "string"
    ) {
      announce({ messageId: e.messageId, text: e.text });
      return;
    }
  }
}

async function emitEndTurn(
  conversationId: string,
  turn: TurnEnd,
): Promise<void> {
  try {
    await conversationTurnCompleted.emit({
      conversationId,
      stopReason: "end_turn",
      text: turn.text,
      messageId: turn.messageId,
    });
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.error(
      `[conversations.turn-emitter] emit failed for ${conversationId}`,
      err,
    );
  }
}

// A durable workflow is "waiting" on this conversation iff the events plugin
// has at least one enabled trigger row keyed to it.
async function hasPendingTrigger(conversationId: string): Promise<boolean> {
  const rows = await executeRows(db, {
    label: "conversation.turn-completed pending trigger",
    query: sql`SELECT id FROM ${_conversationTurnCompletedTriggers}
        WHERE enabled = true AND conversation_id = ${conversationId}
        LIMIT 1`,
    row: z.object({ id: z.string() }),
  });
  return rows.length > 0;
}
