import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { connectionString } from "@plugins/database/plugins/admin/server";
import {
  createDbClient,
  type DbClient,
} from "@plugins/database/plugins/connection/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { parseLiveStatePayload, parseTxnEndPayload } from "./parse-payload";
import { getCoveredTables } from "./triggers";
import { FEED_CHANNEL, TXN_END_CHANNEL } from "./txn-end";
import { feedChange, routeChange, type FeedChange } from "./route-change";
import { routeWithSpan } from "./route-span";
import { createBurstRouter, type TxnEndProblem } from "./burst";
import { changeFeedLog as log } from "./log-sink";

// How often the liveness timer re-checks the socket. This is NOT change-polling
// (changes arrive push-style via NOTIFY); it is a reconnect watchdog that
// re-establishes a socket the `error`/`end` handlers somehow missed (mirrors the
// reconcile timer in git-watcher / file-watcher). The only timer in this plugin.
const LIVENESS_INTERVAL_MS = 30_000;

// Backoff bounds for reconnect after an error/end. Simple capped backoff.
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export interface ChangeFeedListenerOptions {
  connectionString: () => string;
  route: (change: FeedChange) => void;
  coveredTables: () => readonly string[];
  /** Told of a broken end-of-transaction assumption (default: logged and filed as a report). */
  report?: (problem: TxnEndProblem) => void;
  /** How long a transaction's changes wait for its end marker (default 2 s). */
  txnEndDeadlineMs?: number;
  livenessIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  setTimeoutFn?: typeof setTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

// Build an isolated change-feed listener. ALL mutable state is per-instance
// closure state, so two listeners (e.g. production + a test) never share a
// socket, backoff counter, or firstConnect flag. The real deps
// (connectionString / routeChange / getCoveredTables / the global timers) are
// injected so tests can point a listener at a throwaway DB with a recording
// route spy and deterministic timers.
export function createChangeFeedListener(opts: ChangeFeedListenerOptions): {
  start(): void;
  stop(): Promise<void>;
} {
  const livenessIntervalMs = opts.livenessIntervalMs ?? LIVENESS_INTERVAL_MS;
  const reconnectMinMs = opts.reconnectMinMs ?? RECONNECT_MIN_MS;
  const reconnectMaxMs = opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
  const setTimeoutFn = opts.setTimeoutFn ?? globalThis.setTimeout;
  const setIntervalFn = opts.setIntervalFn ?? globalThis.setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? globalThis.clearInterval;

  let client: DbClient | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let connecting = false;
  let firstConnect = true;
  let reconnectDelay = reconnectMinMs;
  // One transaction's NOTIFYs route together once its end marker arrived, so
  // its ack leaves only after every one of them landed (see `createBurstRouter`).
  const burst = createBurstRouter({
    route: (change) => routeWithSpan(change, opts.route),
    report: opts.report ?? reportTxnEndProblem,
    ...(opts.txnEndDeadlineMs !== undefined
      ? { deadlineMs: opts.txnEndDeadlineMs }
      : {}),
  });

  // A single dedicated pg client on the DIRECT socket (connectionString()
  // bypasses pgbouncer, which breaks LISTEN — the same path graphile-worker
  // uses). Drizzle's pgbouncer-fronted pool can't carry a session-bound LISTEN,
  // so this is its own dedicated connection.
  //
  // Built by `createDbClient` (`change-feed`): opening the connection and the
  // `LISTEN` statement each carry the connection plugin's deadline. A connect or
  // LISTEN that gets no reply rejects with `QueryDeadlineExceededError` into the
  // catch below — the same reconnect path as any other connect failure — instead
  // of leaving `connecting` true forever, which also silenced the liveness
  // watchdog. The client it happened on is LOST: abandoned, never closed, and its
  // `end()` is a no-op. An ESTABLISHED LISTEN with no call pending has nothing
  // waiting for a reply, so no deadline sees that socket go silent; that needs a
  // heartbeat.
  async function connect(): Promise<void> {
    if (connecting || client) return;
    connecting = true;
    let attempt: DbClient | null = null;
    try {
      const c = createDbClient({
        name: "change-feed",
        connectionString: opts.connectionString(),
      });
      attempt = c;

      // The two failure paths of an ESTABLISHED listener: a connection-level
      // `error` (socket dropped, PG restarted) and a clean `end`. Both retire the
      // client and schedule a reconnect.
      //
      // Both act only while `c` IS the current client. An attempt that never got
      // there reaches the reconnect path through the catch below, once — and what
      // its socket does afterwards (a late `end`; an `error` on a connection
      // abandoned after a missed deadline and held open) must not tear down the
      // healthy client that replaced it, nor schedule a second reconnect.
      //
      // The listeners stay attached for the client's whole life: pg emits `error`
      // on its socket, and an `error` with no listener is an uncaught exception.
      c.on("error", (err) => {
        log.publish(
          `[change-feed] LISTEN client error: ${String(err)}`,
          "stderr",
        );
        retire(c);
      });
      c.on("end", () => {
        retire(c);
      });

      c.on("notification", (n) => {
        if (!n.payload) return;
        if (n.channel === TXN_END_CHANNEL) {
          const end = parseTxnEndPayload(n.payload);
          if (!end) {
            // Its transaction's changes are released by their deadline
            // (reported there too), never dropped.
            log.publish(
              `[change-feed] skipping unparseable end marker: ${n.payload}`,
              "stderr",
            );
            return;
          }
          burst.end(end);
          return;
        }
        if (n.channel !== FEED_CHANNEL) {
          log.publish(
            `[change-feed] skipping a NOTIFY on unexpected channel "${n.channel}": ${n.payload}`,
            "stderr",
          );
          return;
        }
        const change = parseLiveStatePayload(n.payload, (degraded) =>
          // Routed unscoped (FULL for its readers), never dropped — the same
          // rule the catch-up replay applies to the row.
          log.publish(
            `[change-feed] malformed key layout on a "${degraded.table}" change — routing it unscoped: ${n.payload}`,
            "stderr",
          ),
        );
        if (!change) {
          // Defensive skip — a malformed payload must never crash the listener.
          log.publish(
            `[change-feed] skipping unparseable payload: ${n.payload}`,
            "stderr",
          );
          return;
        }
        burst.change(feedChange(change));
      });

      await c.connect();
      // Both channels in ONE statement: it carries the same deadline, and both
      // LISTENs take effect at its commit — no transaction is seen on one
      // channel and not the other.
      await c.query(`LISTEN ${FEED_CHANNEL}; LISTEN ${TXN_END_CHANNEL}`);
      client = c;
      // This socket hears both channels from here: hold transactions again.
      burst.reopen();
      reconnectDelay = reconnectMinMs; // reset backoff on success

      // Mark-stale-on-RECONNECT only — never on the first (boot) connect.
      //
      // At cold boot the authoritative driver is the bounded catch-up in
      // live-state-snapshot (snapshot floor + changelog replay): because LISTEN is
      // already established here before catch-up runs, replay is precise and
      // gap-free, and it recomputes ONLY the resources whose tables actually
      // changed during downtime. An unconditional fullSweep at boot would instead
      // re-run + re-persist every boot-critical loader, defeating that precision.
      // So skip the sweep on the first successful connect.
      //
      // On a genuine RECONNECT (mid-session socket drop), a dropped socket may have
      // missed NOTIFYs while down, so fullSweep stays as defense-in-depth: it fires
      // a FULL invalidation across every triggered table through `routeChange`
      // (the runtime's one router). A table no resource reads reaches nothing —
      // no declared route or relation read names it — so the sweep only does work for
      // currently-subscribed (or persisted), DB-backed resources.
      //
      // See research/2026-06-23-global-live-state-persisted-read-set-no-boot-recompute.md.
      if (firstConnect) {
        firstConnect = false; // flips only AFTER a successful first connect
      } else {
        fullSweep();
      }

      log.publish(
        `[change-feed] LISTEN ${FEED_CHANNEL}, ${TXN_END_CHANNEL} established`,
      );
    } catch (err) {
      log.publish(`[change-feed] connect failed: ${String(err)}`, "stderr");
      // Close the failed attempt, so a connection whose LISTEN was refused does
      // not linger open. A no-op on a client lost to a missed deadline.
      if (attempt) endQuietly(attempt);
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  // Drop `c` and reconnect — only if `c` is still the current client. Events
  // from any other client (a failed attempt, an already-retired one) are
  // ignored.
  function retire(c: DbClient): void {
    if (client !== c) return;
    client = null;
    // A transaction cut off mid-delivery can never get its end on the next
    // socket (it only hears later commits; the reconnect sweep covers the gap):
    // release it unreported, and hold nothing until a socket listens again.
    burst.close();
    endQuietly(c);
    scheduleReconnect();
  }

  // Not awaited: a socket that already died may never report its `end`.
  function endQuietly(c: DbClient): void {
    // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- trivial fire-and-forget close of an already-dead socket
    void c.end().catch((err: unknown) => {
      // Already-dead socket; surface rather than swallow.
      log.publish(
        `[change-feed] error ending dead client: ${String(err)}`,
        "stderr",
      );
    });
  }

  function fullSweep(): void {
    for (const table of opts.coveredTables()) {
      // A reconnect sweep is a synthesized FULL invalidation — no source
      // transaction corresponds, so no ack attribution (no `xid`).
      routeWithSpan(
        {
          source: "feed",
          table,
          op: "U",
          ids: null,
          keys: null,
          unchanged: null,
        },
        opts.route,
      );
    }
  }

  function scheduleReconnect(): void {
    if (!started) return;
    // The caller has already dropped the client it reconnects from (`retire`),
    // or never had one (a failed attempt), so the next connect() starts clean.
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs);
    setTimeoutFn(() => {
      if (started) void runTracked("change-feed:reconnect", () => connect());
    }, delay);
  }

  function start(): void {
    if (started) return;
    started = true;
    void runTracked("change-feed:connect", () => connect());

    // Liveness watchdog: if the socket is gone (handlers missed, or a reconnect
    // attempt is overdue), re-establish it. Push-adjacent, not change-polling.
    livenessTimer = setIntervalFn(() => {
      if (!client && !connecting) {
        void runTracked("change-feed:reconnect", () => connect());
      }
    }, livenessIntervalMs);
  }

  async function stop(): Promise<void> {
    started = false;
    // A transaction still waiting for its end routes now — never dropped.
    burst.close();
    if (livenessTimer) {
      clearIntervalFn(livenessTimer);
      livenessTimer = null;
    }
    const c = client;
    client = null;
    if (c) {
      try {
        await c.end();
      } catch (err) {
        log.publish(
          `[change-feed] error closing LISTEN client: ${String(err)}`,
          "stderr",
        );
      }
    }
  }

  return { start, stop };
}

// What each broken end-of-transaction assumption means for a reader, filed once
// per kind (the message carries no xid, so one cause is one report) and logged
// with the specifics.
const TXN_END_PROBLEM_MEANING: Record<TxnEndProblem["kind"], string> = {
  "change-after-end":
    "a change arrived after its transaction's end marker — the transaction's ack may have left before it (was the marker fired early, e.g. by SET CONSTRAINTS ALL IMMEDIATE?)",
  "over-count":
    "a transaction sent more changes than its end marker counted — the marker no longer counts every statement",
  interleaved:
    "a transaction's changes were interleaved with another's — its changes were routed before its end marker",
  "txn-end-missing":
    "a transaction's end marker did not arrive in time — its changes were routed without it (is the live_state_txn_end trigger installed?)",
};

function reportTxnEndProblem(problem: TxnEndProblem): void {
  log.publish(
    `[change-feed] ${problem.kind}: ${JSON.stringify(problem)}`,
    "stderr",
  );
  reportServerError({
    message: `[change-feed] ${problem.kind}: ${TXN_END_PROBLEM_MEANING[problem.kind]}`,
    errorType: "ChangeFeedTxnEndError",
  });
}

// Production singleton: the real backend wires one listener to the real deps and
// re-presents it as the existing startListener / stopListener exports that
// change-feed's own server/index.ts calls (onReady / onShutdown). These are NOT
// in the plugin's public barrel, so the factory refactor is fully contained.
const defaultListener = createChangeFeedListener({
  connectionString,
  route: routeChange,
  coveredTables: getCoveredTables,
});

export function startListener(): void {
  defaultListener.start();
}

export async function stopListener(): Promise<void> {
  await defaultListener.stop();
}
