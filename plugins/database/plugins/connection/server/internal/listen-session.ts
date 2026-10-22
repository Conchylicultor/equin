import type { DbPoolName } from "../../core";
import { createDbClient, type DbClient } from "./client";

/** What an open LISTEN session reports (the desktop's `DatabaseDriver.listen`). */
export interface ListenSessionHandlers {
  /** One NOTIFY on a listened channel, in delivery order. */
  notification(channel: string, payload: string): void;
  /**
   * The established session can deliver nothing more: its connection errored
   * or ended. Called at most once, never before `openListenSession` resolved,
   * never after `close()`.
   */
  lost(err: unknown): void;
}

export interface OpenListenSessionOptions {
  /** Which backend connection this is — named on every deadline report. */
  name: DbPoolName;
  /**
   * The DIRECT socket: pgbouncer (transaction pooling) breaks a session-bound
   * LISTEN.
   */
  connectionString: string;
  channels: readonly string[];
  handlers: ListenSessionHandlers;
  /**
   * Told when closing a failed attempt's connection fails. The close is not
   * awaited (a socket that already died may never report its end), so its
   * failure has nowhere else to go.
   */
  endFailed: (err: unknown) => void;
  /** The default per-call bound in place of `QUERY_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
}

// A channel is spliced into the LISTEN statement as an identifier.
const CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Open a LISTEN session on its own connection: `createDbClient`, connect, then
 * LISTEN on every channel in ONE statement — it carries the same deadline, and
 * every LISTEN takes effect at its commit, so no transaction is heard on one
 * channel and not another.
 *
 * Opening the connection and the LISTEN statement each carry the connection
 * deadline: one that gets no reply rejects with `QueryDeadlineExceededError`,
 * like any other failure to open, and the client it happened on is LOST —
 * abandoned, never closed, its `end()` a no-op. A failed attempt is closed (not
 * awaited) and the open rejects; the caller decides whether to retry.
 *
 * An ESTABLISHED session has two failure paths: a connection-level `error`
 * (socket dropped, Postgres restarted) and a clean `end`. Either reaches
 * `handlers.lost` once. Both act only while the session is established and not
 * closed: what a failed attempt's socket does afterwards (a late `end`; an
 * `error` on a connection abandoned after a missed deadline and held open) must
 * not reach the caller, who already got the rejection. The `error` listener
 * stays attached for the client's whole life: pg emits `error` on its socket,
 * and an `error` with no listener is an uncaught exception.
 *
 * An established LISTEN with no call pending has nothing waiting for a reply,
 * so no deadline sees that socket go silent; that needs a heartbeat.
 */
export async function openListenSession(
  options: OpenListenSessionOptions,
): Promise<{ close(): Promise<void> }> {
  const bad = options.channels.filter((c) => !CHANNEL_RE.test(c));
  if (options.channels.length === 0 || bad.length > 0) {
    throw new Error(
      `[connection] openListenSession: channels must be one or more plain identifiers, got ${JSON.stringify(options.channels)}`,
    );
  }
  const { handlers } = options;
  const c: DbClient = createDbClient({
    name: options.name,
    connectionString: options.connectionString,
    ...(options.deadlineMs !== undefined
      ? { deadlineMs: options.deadlineMs }
      : {}),
  });
  let state: "opening" | "open" | "done" = "opening";
  const lose = (err: unknown): void => {
    if (state !== "open") return;
    state = "done";
    handlers.lost(err);
  };
  c.on("error", (err) => lose(err));
  c.on("end", () =>
    lose(new Error(`[connection] ${options.name}: LISTEN connection ended`)),
  );
  // Delivered while OPENING too: once the LISTEN commits, Postgres may hand over
  // a NOTIFY committed in between before it answers the LISTEN statement itself
  // (node-pg emits it as it parses, before `query()` resolves) — dropping it
  // would lose that transaction's change and its ack. Only a session that is
  // done (failed, lost or closed) is silent.
  c.on("notification", (n) => {
    if (state === "done") return;
    handlers.notification(n.channel, n.payload ?? "");
  });

  try {
    await c.connect();
    await c.query(options.channels.map((ch) => `LISTEN ${ch}`).join("; "));
  } catch (err) {
    state = "done";
    // Close the failed attempt, so a connection whose LISTEN was refused does
    // not linger open. A no-op on a client lost to a missed deadline.
    // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- trivial fire-and-forget close of a failed attempt's socket
    void c.end().catch(options.endFailed);
    throw err;
  }
  state = "open";
  return {
    async close() {
      state = "done";
      await c.end();
    },
  };
}
