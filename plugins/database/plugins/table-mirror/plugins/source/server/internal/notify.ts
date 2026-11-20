import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  DatabaseDriver,
  type ListenHandlers,
  type ListenSession,
} from "@plugins/database/server";
import { MirrorSet } from "./define";
import { MIRROR_LOG_CHANNEL } from "./triggers";

/** Told the id of a mirror set whose source log advanced. */
export type MirrorLogAdvancedHandler = (setId: string) => void;

/** What the notifier needs of its host: how to LISTEN, and which sets exist. */
export interface MirrorLogNotifierHost {
  listen(
    channels: readonly string[],
    handlers: ListenHandlers,
  ): Promise<ListenSession>;
  /** Every contributed set's id: the sets re-signalled after a lost session. */
  setIds(): readonly string[];
}

/**
 * One LISTEN on `MIRROR_LOG_CHANNEL`, shared by every subscriber while there
 * is one. A lost session is opened again, and once it is, every subscriber is
 * told every set (a notice may have been missed meanwhile) — so a subscriber
 * never needs to tell a missed notice from a lost one.
 */
export function createMirrorLogNotifier(host: MirrorLogNotifierHost): {
  subscribe(fn: MirrorLogAdvancedHandler): Promise<() => void>;
} {
  const handlers = new Set<MirrorLogAdvancedHandler>();
  let session: Promise<ListenSession> | null = null;

  function open(): Promise<ListenSession> {
    const opened = host.listen([MIRROR_LOG_CHANNEL], {
      notification: (_channel, setId) => {
        for (const fn of handlers) fn(setId);
      },
      lost: () => {
        session = null;
        if (handlers.size === 0) return;
        // Re-signal only once the new LISTEN is up: an advance committed
        // between the loss and the re-LISTEN is then in what a signalled
        // reader sees, never in neither. A failed reopen is loud through
        // `open` itself.
        const reopened = open();
        session = reopened;
        void runTracked(
          "table-mirror: re-signal after mirror-log LISTEN reopened",
          async () => {
            await reopened;
            for (const setId of host.setIds()) {
              for (const fn of handlers) fn(setId);
            }
          },
        );
      },
    });
    // A failed open is loud (an unhandled rejection) and leaves no session,
    // so the next subscription opens again.
    opened.catch((err: unknown) => {
      if (session === opened) session = null;
      throw err;
    });
    return opened;
  }

  return {
    async subscribe(fn) {
      handlers.add(fn);
      session ??= open();
      try {
        await session;
      } catch (err) {
        handlers.delete(fn);
        throw err;
      }
      return () => {
        if (!handlers.delete(fn)) return;
        if (handlers.size === 0 && session !== null) {
          const closing = session;
          session = null;
          void runTracked("table-mirror: close mirror-log LISTEN", async () =>
            (await closing).close(),
          );
        }
      };
    },
  };
}

const notifier = createMirrorLogNotifier({
  listen: (channels, handlers) =>
    DatabaseDriver.get().listen("mirror-log-notify", channels, handlers),
  setIds: () => MirrorSet.getContributions().map((s) => s.id),
});

/**
 * Call `fn` with a set's id whenever its source log advances — push-based:
 * the log triggers NOTIFY `table_mirror_log` with the set id in the
 * transaction that logged the change (insert, update, delete, a cascaded
 * delete, a truncate), so `fn` runs once that transaction commits, at most
 * once per set per transaction. After a lost LISTEN session is open again,
 * `fn` is called with every contributed set (a notice may have been missed).
 *
 * Resolves to the unsubscribe once the LISTEN is active — so a read made after
 * it cannot miss a change committed meanwhile. Rejects, subscribing nothing,
 * when the LISTEN cannot be opened. The session lives while anyone is
 * subscribed. A signal carries no data: read the log (`readMirrorChanges`)
 * for what changed.
 */
export function onMirrorLogAdvanced(
  fn: MirrorLogAdvancedHandler,
): Promise<() => void> {
  return notifier.subscribe(fn);
}
