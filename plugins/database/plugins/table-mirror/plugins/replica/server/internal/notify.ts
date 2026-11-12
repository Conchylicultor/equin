import { z } from "zod";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { DatabaseDriver, type ListenSession } from "@plugins/database/server";

/** The channel every apply transaction NOTIFYs at its commit. */
export const REPLICA_CHANNEL = "table_mirror";

export const ReplicaNoticeSchema = z.object({
  replicaId: z.string(),
  setId: z.string(),
});
export type ReplicaNotice = z.infer<typeof ReplicaNoticeSchema>;

/**
 * Told when a replica of the set committed a page: `replicaId`, or `null`
 * once a lost LISTEN session is open again, a notice having maybe been missed
 * (re-read every replica of the set).
 */
export type ReplicaAppliedHandler = (replicaId: string | null) => void;

const handlers = new Map<ReplicaAppliedHandler, string>();
let session: Promise<ListenSession> | null = null;

function dispatch(payload: string): void {
  const notice = ReplicaNoticeSchema.parse(JSON.parse(payload));
  for (const [fn, setId] of handlers) {
    if (setId === notice.setId) fn(notice.replicaId);
  }
}

function open(): Promise<ListenSession> {
  const opened = DatabaseDriver.get().listen([REPLICA_CHANNEL], {
    notification: (_channel, payload) => dispatch(payload),
    lost: () => {
      session = null;
      if (handlers.size === 0) return;
      // Re-read only once the new LISTEN is up: a page committed between the
      // loss and the re-LISTEN is then in what the re-read sees, never in
      // neither. A failed reopen is loud through `open` itself.
      const reopened = open();
      session = reopened;
      void reopened.then(() => {
        for (const fn of handlers.keys()) fn(null);
      });
    },
  });
  // A failed open is loud (an unhandled rejection) and leaves no session, so
  // the next subscription opens again.
  opened.catch((err: unknown) => {
    if (session === opened) session = null;
    throw err;
  });
  return opened;
}

/**
 * Call `fn` whenever a replica of `setId` commits a page — push-based: the
 * apply transaction itself NOTIFYs `table_mirror` at its commit. A served
 * value over a replica calls its own `notify()` from it. Resolves to the
 * unsubscribe once the LISTEN is active — so a read made after it cannot miss
 * a page committed meanwhile (a served value's `whileSubscribed` returns this
 * promise; its first load waits for it). Rejects, subscribing nothing, when
 * the LISTEN cannot be opened. The session lives while anyone is subscribed.
 */
export async function onReplicaApplied(
  setId: string,
  fn: ReplicaAppliedHandler,
): Promise<() => void> {
  handlers.set(fn, setId);
  session ??= open();
  try {
    await session;
  } catch (err) {
    handlers.delete(fn);
    throw err;
  }
  return () => {
    handlers.delete(fn);
    if (handlers.size === 0 && session !== null) {
      const closing = session;
      session = null;
      void runTracked("table-mirror: close replica LISTEN", async () =>
        (await closing).close(),
      );
    }
  };
}
