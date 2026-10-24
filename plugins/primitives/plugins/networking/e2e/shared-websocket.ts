// End-to-end check of the shared socket (`SharedWebSocket` + its SharedWorker).
//
// Every tab of a browser context attaches to ONE server connection owned by
// the SharedWorker, and a tab closing never interrupts the others — there is
// no leader to fail over from. Observed through the shared socket's tap
// (`tapSharedSocket`): the socket lives in the worker, out of Playwright's
// `page.on("websocket")` reach.
//
// The push it watches for is a notification created with the app's own
// endpoint (the bell's `notifications` collection, which every page holds
// live) and dismissed at the end, whatever the outcome.
//
// Usage:
//   1. `./equin build` (to deploy the current worktree)
//   2. `./equin run plugins/primitives/plugins/networking/e2e/shared-websocket.ts [--headed]`
//
// Exits non-zero on any failure.
import {
  boot,
  capture,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { tapSharedSocket, type SocketTap } from "./index";

const WS = "/ws/notifications";
/** How long a push may take to reach a tab over a live connection. */
const PUSH_TIMEOUT_MS = 1_000;
const SETTLE_TIMEOUT_MS = 10_000;

const r = report("networking · one shared socket across tabs");

/** Whether any recorded frame mentions `id`. */
const sawFrameFor = (frames: string[], id: string): boolean =>
  frames.some((f) => f.includes(id));

await withBrowser(async (h) => {
  const { context: ctx, page: a } = await h.session({ label: "a" });
  const created: string[] = [];

  const push = async (page: Page, id: string): Promise<void> => {
    const res = await page.request.post(pathUrl("/api/notifications"), {
      data: {
        id,
        type: "e2e-shared-websocket",
        title: id,
        description: "seeded by networking/e2e/shared-websocket.ts",
        variant: "info",
      },
    });
    if (!res.ok()) throw new Error(`POST /api/notifications — ${res.status()}`);
    created.push(id);
  };

  const open = async (
    page: Page,
  ): Promise<{ tap: SocketTap; frames: string[] }> => {
    const tap = await tapSharedSocket(page);
    const frames: string[] = [];
    tap.onFrame((f) => {
      if (f.url === WS) frames.push(f.data);
    });
    await boot(page, pathUrl("/"), { settleMs: 1500 });
    const bound = await waitFor(
      () => Promise.resolve(tap.connections(WS)),
      (conns) => conns.length > 0,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    if (!bound.ok) throw new Error(`a tab never bound to a ${WS} connection`);
    return { tap, frames };
  };

  try {
    const tabA = await open(a);
    const b = await ctx.newPage();
    capture(b, "b");
    const tabB = await open(b);

    // ── one connection, shared ────────────────────────────────────────────
    r.eq(
      "both tabs are bound to the SAME server connection",
      tabB.tap.connections(WS),
      tabA.tap.connections(WS),
    );
    const conn = tabA.tap.connections(WS).at(-1);

    // ── a push reaches the second tab ─────────────────────────────────────
    const first = `e2e-shared-ws-${Date.now()}-1`;
    await push(b, first);
    const reachedB = await waitFor(
      () => Promise.resolve(sawFrameFor(tabB.frames, first)),
      (seen) => seen,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 50 },
    );
    r.ok(
      "a push reaches the tab that did not open the connection",
      reachedB.ok,
      `${reachedB.waitedMs}ms`,
    );

    // ── closing the first tab leaves the survivor live, with no gap ───────
    await a.close();
    const second = `e2e-shared-ws-${Date.now()}-2`;
    await push(b, second);
    const survived = await waitFor(
      () => Promise.resolve(sawFrameFor(tabB.frames, second)),
      (seen) => seen,
      { timeoutMs: PUSH_TIMEOUT_MS, intervalMs: 50 },
    );
    r.ok(
      `closing the first tab — the survivor gets the next push within ${PUSH_TIMEOUT_MS}ms`,
      survived.ok,
      `${survived.waitedMs}ms`,
    );
    r.eq(
      "…on the same connection (no reconnect, no replay)",
      tabB.tap.connections(WS).at(-1),
      conn,
    );
    r.eq("…which stayed open", tabB.tap.status(WS), "open");
  } finally {
    for (const id of created) {
      const res = await ctx.request.post(
        pathUrl(`/api/notifications/${id}/dismiss`),
        { data: {} },
      );
      r.ok(`cleanup dismissed ${id}`, res.ok(), `HTTP ${res.status()}`);
    }
    await ctx.close();
  }
});

await r.finish();
