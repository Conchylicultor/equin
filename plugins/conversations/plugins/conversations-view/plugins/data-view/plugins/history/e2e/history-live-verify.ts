/**
 * The sidebar History list is a LIVE source of the merged
 * `conversations-sidebar` DataView (`conversations.history`, P7 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md) — the first
 * merged surface with a live origin:
 *
 *  1. seeds a task, its attempt, a `user` and a `system` conversation (inert:
 *     closed, the task's title not machine-made) and opens the sidebar on the
 *     History view: BOTH are listed (History has no default scope);
 *  2. the system conversation's status flips (done → gone → done) in the
 *     database: History receives it, live — the revision tick it replaced
 *     hashed non-system rows only and never did;
 *  3. the task is renamed through the REAL rename endpoint: History receives
 *     the new task title for its rows, live (the `tasks` reverse route);
 *  4. a poller write sends History nothing;
 *  5. the task is deleted: both rows leave (the cascade);
 *  6. no HTTP read of `conversations.history` after the first listing — rows arrive
 *     only over the socket — and the page never reloaded.
 *
 * A row is named per the user's "Conversation list title" setting, so the
 * on-screen checks accept the conversation's title or its task's.
 *
 * Seeds go straight into the deploy's database and are deleted at the end
 * (also on failure). Refuses main.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/history/e2e/history-live-verify.ts [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import {
  frameOf,
  renameTask,
  seedConversations,
  sweepSeeded,
} from "@plugins/conversations/plugins/all-conversations/e2e";

const OUT = arg("out") ?? "/tmp/conversations-history-live";
const db = openDeployDb();

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await sweepSeeded(db);
  await db.close();
}
onBeforeFinish(cleanup);

/** How many leaf elements on screen show one of `texts` exactly. */
async function countShown(page: Page, texts: string[]): Promise<number> {
  return page.evaluate((wanted) => {
    let n = 0;
    for (const el of document.querySelectorAll("body *")) {
      const t = el.textContent?.trim() ?? "";
      if (el.children.length === 0 && wanted.includes(t)) n++;
    }
    return n;
  }, texts);
}

const HISTORY_FRAME = frameOf("conversations.history");

try {
  await sweepSeeded(db);
  const seed = await seedConversations(db);
  // A row is named by its conversation title, its task's, or (no short title
  // exists for a seeded task) its task's again.
  const names = [seed.user.title, seed.system.title, seed.taskTitle];

  await withBrowser(async (h) => {
    const r = report("history — routed live merged source");
    const { page } = await h.session();
    // Open the sidebar on the History view (the switcher's device-local choice).
    await page.addInitScript(() => {
      localStorage.setItem("conversations-sidebar:active-view", "history");
    });
    const frames: string[] = [];
    // Through the shared socket's tap: the socket lives in a SharedWorker, out
    // of `page.on("websocket")`'s reach.
    (await tapSharedSocket(page)).onFrame((f) => frames.push(f.data));
    // Every HTTP read of the list's live resource (its window or `:rows`):
    // the cold-boot prime may make one before the socket is up; after that,
    // rows must arrive ONLY over the socket — a read here is a refetch.
    const httpReads: string[] = [];
    page.on("request", (req) => {
      if (
        new URL(req.url()).pathname.startsWith(
          "/api/resources/conversations.history",
        )
      ) {
        httpReads.push(req.url());
      }
    });
    const historyFramesSince = (at: number) =>
      frames.slice(at).filter((f) => HISTORY_FRAME.test(f));

    await boot(page, pathUrl("/agents"), {
      marker: "[data-app-tab]",
      timeoutMs: 120_000,
      settleMs: 800,
    });
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    // 1. Both conversations, the system one included.
    const listed = await waitFor(
      () => countShown(page, names),
      (n) => n === 2,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "History lists both seeded conversations, the system one included",
      listed.ok,
      `${listed.value} shown`,
    );
    await snap(page, OUT, "1-seeded");

    httpReads.length = 0;

    // 2. A system conversation's status flip reaches History.
    let at = frames.length;
    await db.query("UPDATE conversations SET status = 'gone' WHERE id = $1", [
      seed.system.id,
    ]);
    const flipped = await waitFor(
      async () => historyFramesSince(at),
      (fs) =>
        fs.some((f) => f.includes(seed.system.id) && f.includes('"gone"')),
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a system conversation's status flip reaches History, live",
      flipped.ok,
      `${flipped.value.length} History frame(s) after ${flipped.waitedMs}ms`,
    );
    await db.query("UPDATE conversations SET status = 'done' WHERE id = $1", [
      seed.system.id,
    ]);

    // 3. A rename through the real endpoint reaches the rows' task title.
    const renamed = `${seed.taskTitle} renamed`;
    at = frames.length;
    await renameTask(seed.taskId, renamed);
    const relabel = await waitFor(
      async () => historyFramesSince(at),
      (fs) => fs.some((f) => f.includes(renamed)),
      { timeoutMs: 30_000 },
    );
    r.ok(
      "renaming the task reaches History's rows (taskTitle), live",
      relabel.ok,
      `after ${relabel.waitedMs}ms`,
    );

    // 4. A poller write: nothing.
    at = frames.length;
    await db.query(
      "UPDATE conversations SET waiting_for = 'permission', last_viewed_at = now() WHERE id = $1",
      [seed.user.id],
    );
    await db.query(
      "UPDATE conversations SET waiting_for = NULL WHERE id = $1",
      [seed.user.id],
    );
    await page.waitForTimeout(2500);
    r.eq(
      "a poller write (waiting_for / last_viewed_at) sends History nothing",
      historyFramesSince(at),
      [],
    );
    await snap(page, OUT, "2-after-edits");

    // 5. The task deleted: both rows leave.
    await db.query("DELETE FROM tasks WHERE id = $1", [seed.taskId]);
    const gone = await waitFor(
      () => countShown(page, [...names, renamed]),
      (n) => n === 0,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "deleting the task removes both rows, live",
      gone.ok,
      `${gone.value} left after ${gone.waitedMs}ms`,
    );

    r.eq(
      "no HTTP read of conversations.history after the first listing (socket only)",
      httpReads,
      [],
    );
    const noReload = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    r.ok("the page never reloaded", noReload);
    await r.finish();
  });
} finally {
  await cleanup();
}
