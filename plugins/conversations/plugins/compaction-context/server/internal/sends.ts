import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _compactionContextSends } from "./tables";

/** A compaction context handed to a hook, not yet checked against the transcript. */
export interface CompactionContextSend {
  conversationId: string;
  context: string;
  sentAt: Date;
}

type Listener = (send: CompactionContextSend) => void;
const listeners = new Set<Listener>();

/**
 * Hear every compaction context the endpoint hands out, in-process, right after
 * it is recorded. Returns the unsubscribe. A listener must not throw.
 */
export function onCompactionContextSent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record what the hook is about to get (replacing an older send), then tell the listeners. */
export async function recordSend(send: CompactionContextSend): Promise<void> {
  await db
    .insert(_compactionContextSends)
    .values(send)
    .onConflictDoUpdate({
      target: _compactionContextSends.conversationId,
      set: { context: send.context, sentAt: send.sentAt },
    });
  for (const listener of listeners) listener(send);
}

/** Every send still waiting for its check — what a check reloads at boot. */
export async function pendingSends(): Promise<CompactionContextSend[]> {
  return db.select().from(_compactionContextSends);
}

/** The check decided `send`: drop it, unless a later compaction replaced it. */
export async function settleSend(send: CompactionContextSend): Promise<void> {
  await db
    .delete(_compactionContextSends)
    .where(
      and(
        eq(_compactionContextSends.conversationId, send.conversationId),
        eq(_compactionContextSends.sentAt, send.sentAt),
      ),
    );
}
