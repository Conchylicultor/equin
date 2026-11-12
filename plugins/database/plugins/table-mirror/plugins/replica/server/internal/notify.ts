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
 * when the LISTEN session was lost and a notice may have been missed (re-read
 * every replica of the set).
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
      for (const fn of handlers.keys()) fn(null);
      if (handlers.size > 0) session = open();
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
 * value over a replica calls its own `notify()` from it. Returns the
 * unsubscribe; the LISTEN session lives while anyone is subscribed.
 */
export function onReplicaApplied(
  setId: string,
  fn: ReplicaAppliedHandler,
): () => void {
  handlers.set(fn, setId);
  session ??= open();
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
