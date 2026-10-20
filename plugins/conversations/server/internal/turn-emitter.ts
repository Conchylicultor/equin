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
import { watchTranscript } from "@plugins/conversations/plugins/transcript-watcher/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  _conversationTurnCompletedTriggers,
  conversationTurnCompleted,
} from "./tables-turn-completed-event";

// conversationId → unsubscribe
const subscriptions = new Map<string, () => void>();

// Every reconcile — the boot one and each per-conversation one — runs through
// this one-at-a-time gate and reads the DB inside its turn. Otherwise the boot
// read could see X active, X→done's reconcile unsubscribe it, and boot then
// resubscribe X from its stale read. Serialized, the last writer is always the
// freshest read. A failing turn rejects its own caller and frees the gate.
const reconcileGate = createSemaphore(1);

// Converges one conversation's subscription on its current DB status. The
// event that woke it is only a wake-up: out-of-order, duplicate or replayed
// events all land on the same truth.
function reconcile(conversationId: string): Promise<void> {
  return reconcileGate.run(async () => {
    const row = await getConversationRuntime(conversationId);
    const active = row !== null && isActiveStatus(row.status);
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
    for (const c of convs) {
      if (!isActiveStatus(c.status) || subscriptions.has(c.id)) continue;
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

type EndTurnEvent = Extract<JsonlEvent, { kind: "assistant-text" }> & {
  messageId: string;
};

function subscribeToConversation(conversationId: string): () => void {
  let hasPrimed = false;
  const emittedIds = new Set<string>();

  async function handleEvents(events: JsonlEvent[]): Promise<void> {
    const endTurns = events.filter(
      (e): e is EndTurnEvent =>
        e.kind === "assistant-text" &&
        e.stopReason === "end_turn" &&
        typeof e.messageId === "string",
    );

    if (!hasPrimed) {
      // First callback (seed read): populate dedupe set without emitting.
      // Exception: if a durable job is waiting on this conversation, replay
      // the most recent end_turn so it can resume after a server restart.
      for (const t of endTurns) emittedIds.add(t.messageId);
      hasPrimed = true;
      if (endTurns.length > 0 && (await hasPendingTrigger(conversationId))) {
        const latest = endTurns[endTurns.length - 1];
        if (latest) await emitEndTurn(conversationId, latest);
      }
      return;
    }

    for (const t of endTurns) {
      if (emittedIds.has(t.messageId)) continue;
      emittedIds.add(t.messageId);
      await emitEndTurn(conversationId, t);
    }
  }

  return watchTranscript(conversationId, ({ events }) => {
    void runTracked("conversations:turn-emitter-events", () =>
      handleEvents(events),
    );
  });
}

async function emitEndTurn(
  conversationId: string,
  turn: EndTurnEvent,
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
