/**
 * A reconnect after a subscription gap replays a FRESH value, end to end on a
 * deployed build.
 *
 * The bug (research/2026-09-27-global-live-substrate-gaps.md, gap 1): the
 * live-state server used to answer a reconnecting tab's replay with
 * `up-to-date`/`up-to-date-batch` from memory even when the truth changed
 * while the tab's WebSocket was down and nobody else was subscribed — the
 * per-pk version counter it compared against was never bumped for an
 * untracked tuple, so an echoed version could still match. The fix
 * (`registerSubOnSocket` in resource-runtime/core/runtime.ts) makes every
 * subscription span open with a FRESH version on the global 0→1 transition,
 * so a replay that arrives after the old socket's `close` was processed can
 * never short-circuit — it always takes the full path and gets a real
 * `sub-ack`.
 *
 * Resource under test: the notifications bell's `notifications` collection
 * (`plugins/shell/plugins/notifications`) — a `liveCollection` window
 * (bounded, DB-backed, preloaded at boot), changeable from outside the page
 * with one HTTP call (`POST /api/notifications`), harmless and reversible
 * (the created row is dismissed in a `finally`).
 *
 * Mechanism: the shared socket's e2e tap (`tapSharedSocket`,
 * `@plugins/primitives/plugins/networking/e2e`) — the socket lives in a
 * SharedWorker, out of Playwright's `routeWebSocket` reach — so the app behaves
 * normally except for the one thing this script controls:
 *
 *   1. drop the connection (`tap.drop`) — the backend sees a real close and
 *      releases the tab's subs, ending the tracking span for every tuple it
 *      held;
 *   2. HOLD the reconnect — `tap.hold` (armed before the drop) parks every new
 *      connection attempt in the worker until `tap.release`;
 *   3. make the HTTP change while the reconnect is held, wait ~1s, then
 *      release;
 *   4. assert the page shows the change within a few seconds, and record
 *      which frame answered the `notifications` replay on the new connection
 *      — the fixed server must answer `sub-ack` (fresh data), never
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
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import type { Page } from "playwright";

const OUT = "/tmp/claude-501/reconnect-after-gap";
const r = report(
  "network/live · a reconnect after a subscription gap replays a fresh value",
);

/** How long the reconnect is held while the HTTP change lands. */
const RECONNECT_HOLD_MS = 1000;
/** How long the DOM may take to reflect the reconnect's replay. */
const SETTLE_TIMEOUT_MS = 10_000;

const NOTIFICATIONS_WS = "/ws/notifications";

const bell = (page: Page) =>
  page.getByRole("button", { name: /^Notifications/ });
const rows = (page: Page) =>
  page.locator('[data-testid="notification-list"] li');

/** One frame that answered a resource's replay on a given connection. */
interface ReplayFrame {
  kind: "sub-ack" | "up-to-date-batch";
  conn: string | null;
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
      (replaysFor[msg.key] ??= []).push({ kind: "sub-ack", conn: f.conn });
    } else if (msg.kind === "up-to-date-batch" && Array.isArray(msg.entries)) {
      for (const e of msg.entries) {
        if (!e.key) continue;
        (replaysFor[e.key] ??= []).push({
          kind: "up-to-date-batch",
          conn: f.conn,
        });
      }
    }
  });

  const stamp = Date.now();
  const id = `e2e-reconnect-gap-${stamp}`;
  const title = `e2e reconnect-after-gap ${stamp}`;
  let created = false;

  try {
    await boot(page, pathUrl("/"), { settleMs: 1500 });

    await bell(page).click();
    await page
      .locator('[data-testid="notification-list"]')
      .waitFor({ timeout: SETTLE_TIMEOUT_MS });
    await snap(page, OUT, "1-before");

    // The initial popover paint can come straight from the boot-snapshot
    // cache, so the live socket may not have connected yet even once the
    // list is visible — poll for it rather than asserting immediately.
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
    // backend sees a real close and releases this tab's subs — every tuple it
    // held (including `notifications`) ends its tracking span right here.
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

    // The HTTP change, made entirely inside the gap: nobody is subscribed to
    // `notifications` right now (the socket that held it is closed, and the
    // reconnect is parked), so this is exactly the "changed while untracked"
    // case the fix targets.
    await post("/api/notifications", {
      id,
      type: "e2e-reconnect-gap",
      title,
      description: "seeded by reconnect-after-gap.ts",
      variant: "info",
    });
    created = true;
    r.note(`created notification ${id} while the reconnect was held`);

    await page.waitForTimeout(RECONNECT_HOLD_MS);

    r.note("releasing the reconnect");
    await tap.release(NOTIFICATIONS_WS);

    // The page shows the change within a few seconds — poll (read, then
    // re-read to a deadline), never a fixed sleep.
    const settled = await waitFor(
      () => rows(page).filter({ hasText: title }).count(),
      (n) => n > 0,
      { timeoutMs: SETTLE_TIMEOUT_MS },
    );
    r.ok(
      `the new notification appears after the reconnect (${settled.waitedMs}ms, ${settled.attempts} attempt(s))`,
      settled.ok,
      `rows matching title = ${settled.value}`,
    );
    await snap(page, OUT, "2-after");

    // Which frame answered the `notifications` replay on the reconnect?
    const reconnected = tap.connections(NOTIFICATIONS_WS).at(-1);
    const onReconnect = (replaysFor["notifications"] ?? []).filter(
      (f) => f.conn !== null && f.conn === reconnected && f.conn !== dropped,
    );
    r.note(
      `notifications replay frame(s) on connection ${reconnected}: ${JSON.stringify(onReconnect)}`,
    );
    r.ok(
      "the `notifications` resource replayed on the reconnect",
      onReconnect.length > 0,
    );
    r.eq(
      "…and it was answered with a `sub-ack` (fresh data), never `up-to-date-batch` — the reconnect fix",
      onReconnect.map((f) => f.kind),
      onReconnect.length > 0 ? ["sub-ack"] : [],
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
