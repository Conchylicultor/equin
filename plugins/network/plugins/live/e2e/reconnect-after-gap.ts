/**
 * A reconnect after a subscription gap replays a FRESH value, end to end on a
 * deployed build.
 *
 * The bug (research/2026-09-27-global-live-substrate-gaps.md, gap 1): the
 * live-state server used to answer a reconnecting tab's replay with
 * `up-to-date`/`up-to-date-batch` from memory even when the truth changed
 * while the tab's WebSocket was down and nobody else was subscribed — the
 * per-pk version counter it compared against was never bumped for an
 * untracked tuple, so an echoed version could still match. Today a closed
 * socket's subs LINGER (resource-runtime's `detached`,
 * research/2026-11-04-global-live-reconnect-linger-and-version-clock.md): the
 * tuple stays tracked through the gap, so the change made in it moves the
 * version, and the replay — which would short-circuit had nothing changed —
 * must take the full path and get a real `sub-ack` carrying the change. (A gap
 * past the linger opens a new span at a fresh version: also a full path.)
 *
 * Resource under test: the notifications bell's `notifications` collection
 * (`plugins/shell/plugins/notifications`) — a `liveCollection` window
 * (bounded, DB-backed, preloaded at boot, so subscribed with no UI open),
 * changeable from outside the page
 * with one HTTP call (`POST /api/notifications`), harmless and reversible
 * (the created row is dismissed in a `finally`).
 *
 * Mechanism: the shared socket's e2e tap (`tapSharedSocket`,
 * `@plugins/primitives/plugins/networking/e2e`) — the socket lives in a
 * SharedWorker, out of Playwright's `routeWebSocket` reach — so the app behaves
 * normally except for the one thing this script controls:
 *
 *   1. drop the connection (`tap.drop`) — the backend sees a real close and
 *      detaches the tab's subs (they linger, still tracked, for the replay);
 *   2. HOLD the reconnect — `tap.hold` (armed before the drop) parks every new
 *      connection attempt in the worker until `tap.release`;
 *   3. make the HTTP change while the reconnect is held, wait ~1s, then
 *      release;
 *   4. assert the frame that answered the `notifications` replay on the new
 *      connection is a `sub-ack` carrying the new row — never
 *      `up-to-date-batch`.
 *
 * WRITES: creates one notification via the app's own endpoint and dismisses
 * it in a `finally`, whatever the run's outcome.
 *
 * Usage:
 *   ./equin run plugins/network/plugins/live/e2e/reconnect-after-gap.ts [--headed]
 */

import {
  boot,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import { notificationIdKind } from "@plugins/shell/plugins/notifications/core";

const r = report(
  "network/live · a reconnect after a subscription gap replays a fresh value",
);

/** How long the reconnect is held while the HTTP change lands. */
const RECONNECT_HOLD_MS = 1000;
/** How long a socket or a replay answer may take. */
const SETTLE_TIMEOUT_MS = 10_000;

const NOTIFICATIONS_WS = "/ws/notifications";

/** One frame that answered a resource's replay on a given connection. */
interface ReplayFrame {
  kind: "sub-ack" | "up-to-date-batch";
  conn: string | null;
  /** The frame carries the row the run created in the gap. */
  carriesNew: boolean;
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  const post = async (path: string, data?: unknown) => {
    const res = await page.request.post(pathUrl(path), { data: data ?? {} });
    if (!res.ok()) throw new Error(`POST ${path} — ${res.status()}`);
  };

  // --- tap /ws/notifications --------------------------------------------
  // Every server→page frame is inspected to record which frame answered which
  // resource's replay, on which server connection.
  const tap = await tapSharedSocket(page);
  const stamp = Date.now();
  const id = notificationIdKind.mint();
  const title = `e2e reconnect-after-gap ${stamp}`;
  const replaysFor: Record<string, ReplayFrame[]> = {};
  tap.onFrame((f) => {
    if (f.url !== NOTIFICATIONS_WS) return;
    // Every live-state frame is one JSON object.
    const msg = JSON.parse(f.data) as {
      kind?: string;
      key?: string;
      entries?: Array<{ key?: string }>;
    };
    if (msg.kind === "sub-ack" && msg.key) {
      (replaysFor[msg.key] ??= []).push({
        kind: "sub-ack",
        conn: f.conn,
        carriesNew: f.data.includes(id),
      });
    } else if (msg.kind === "up-to-date-batch" && Array.isArray(msg.entries)) {
      for (const e of msg.entries) {
        if (!e.key) continue;
        (replaysFor[e.key] ??= []).push({
          kind: "up-to-date-batch",
          conn: f.conn,
          carriesNew: false,
        });
      }
    }
  });

  let created = false;

  try {
    await boot(page, pathUrl("/"), { settleMs: 1500 });

    // `notifications` is boot-preloaded, so the page holds it with no UI open
    // (hydrated from the boot snapshot, subscribed once the socket opens) —
    // poll for the socket rather than asserting immediately.
    const opened = await waitFor(
      () => Promise.resolve(tap.connections(NOTIFICATIONS_WS)),
      (conns) => conns.length > 0,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    r.ok(
      "the app opened its /ws/notifications connection",
      opened.ok,
      `connections=${opened.value.length}`,
    );
    const dropped = opened.value.at(-1);

    // Arm the hold for the RECONNECT, then drop the CURRENT connection: the
    // backend sees a real close and detaches this tab's subs — every tuple it
    // held (including `notifications`) lingers, still tracked, for the replay.
    await tap.hold(NOTIFICATIONS_WS);
    r.note(`dropping connection ${dropped}`);
    await tap.drop(NOTIFICATIONS_WS);

    // Confirm the drop reached the page (the worker reports the lost
    // connection) before making the change — with the hold armed, no new
    // connection can open until the release, so the change is guaranteed to
    // land entirely inside the gap.
    const held = await waitFor(
      () => Promise.resolve(tap.status(NOTIFICATIONS_WS)),
      (status) => status === "reconnecting",
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    r.ok(
      "the connection dropped and the reconnect is held",
      held.ok,
      `status=${held.value}`,
    );

    // The HTTP change, made entirely inside the gap: no live socket holds
    // `notifications` right now (the one that held it is closed, and the
    // reconnect is parked) — the "changed while the tab was away" case.
    await post("/api/notifications", {
      id,
      type: "e2e-reconnect-gap",
      category: "other",
      title,
      description: "seeded by reconnect-after-gap.ts",
      variant: "info",
    });
    created = true;
    r.note(`created notification ${id} while the reconnect was held`);

    await page.waitForTimeout(RECONNECT_HOLD_MS);

    r.note("releasing the reconnect");
    await tap.release(NOTIFICATIONS_WS);

    // Which frame answered the `notifications` replay on the reconnect?
    const replayed = await waitFor(
      () => {
        const reconnected = tap.connections(NOTIFICATIONS_WS).at(-1);
        return Promise.resolve(
          (replaysFor["notifications"] ?? []).filter(
            (f) =>
              f.conn !== null && f.conn === reconnected && f.conn !== dropped,
          ),
        );
      },
      (answers) => answers.length > 0,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    const onReconnect = replayed.value;
    const reconnected = tap.connections(NOTIFICATIONS_WS).at(-1);
    r.note(
      `notifications replay frame(s) on connection ${reconnected}: ${JSON.stringify(onReconnect)}`,
    );
    r.ok(
      "the `notifications` resource replayed on the reconnect",
      onReconnect.length > 0,
    );
    r.ok(
      "…and every tuple of it was answered with a `sub-ack` (fresh data), never `up-to-date-batch`",
      onReconnect.length > 0 && onReconnect.every((f) => f.kind === "sub-ack"),
      JSON.stringify(onReconnect.map((f) => f.kind)),
    );
    r.ok(
      `…carrying the notification made in the gap (${title})`,
      onReconnect.some((f) => f.carriesNew),
    );
  } finally {
    if (created) {
      const res = await page.request.post(
        pathUrl(`/api/notifications/${id}/dismiss`),
        { data: {} },
      );
      r.ok(`cleanup dismissed ${id}`, res.ok(), `HTTP ${res.status()}`);
    }
  }

  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
