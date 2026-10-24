/**
 * The All-conversations pane is a LIVE window over `conversations` joined to
 * its attempt and task (`conversations.all`, P7 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md) — no revision
 * tick, no HTTP refetch, no reload:
 *
 *  1. seeds a task, its attempt, a `user` and a `system` conversation (inert:
 *     closed, the task's title not machine-made); the user one is listed, the
 *     system one is not (the `unless: kind` default);
 *  2. a poller write (`waiting_for`, `last_viewed_at`) sends the list NOTHING
 *     (outside the route gate);
 *  3. the task is renamed through the REAL rename endpoint: the row's Task
 *     column relabels, live (the `tasks` reverse route);
 *  4. the conversation is retitled in the database: the row relabels, live;
 *  5. the task is deleted: its conversation leaves the list (the cascade);
 *  6. no HTTP read of `conversations.all` after the first listing — rows arrive
 *     only over the socket — and the page never reloaded.
 *
 * Seeds go straight into the deploy's database (out of band, so anything on
 * screen came off the server) and are deleted at the end (also on failure).
 * Refuses main.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/conversations/plugins/all-conversations/e2e/list-live-verify.ts [--headed]
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

const OUT = arg("out") ?? "/tmp/conversations-list-live";
const db = openDeployDb();

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await sweepSeeded(db);
  await db.close();
}
onBeforeFinish(cleanup);

/** Which of `texts` some leaf element on screen shows exactly. */
async function shownOf(page: Page, texts: string[]): Promise<string[]> {
  return page.evaluate((wanted) => {
    const seen = new Set<string>();
    for (const el of document.querySelectorAll("body *")) {
      const t = el.textContent?.trim() ?? "";
      if (el.children.length === 0 && wanted.includes(t)) seen.add(t);
    }
    return [...seen].sort();
  }, texts);
}

const LIST_FRAME = frameOf("conversations.all");

try {
  await sweepSeeded(db);
  const seed = await seedConversations(db);

  await withBrowser(async (h) => {
    const r = report("all-conversations — routed live list");
    const { page } = await h.session();
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
          "/api/resources/conversations.all",
        )
      ) {
        httpReads.push(req.url());
      }
    });
    const listFramesSince = (at: number) =>
      frames.slice(at).filter((f) => LIST_FRAME.test(f));

    await boot(page, pathUrl("/agents/all-conversations"), {
      marker: `text=${seed.user.title}`,
      timeoutMs: 120_000,
      settleMs: 800,
    });
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    // 1. The user conversation is listed; the system one is hidden by default.
    r.eq(
      "the user conversation is listed, the system one hidden by default",
      await shownOf(page, [seed.user.title, seed.system.title]),
      [seed.user.title],
    );
    const task = await waitFor(
      () => shownOf(page, [seed.taskTitle]),
      (s) => s.length === 1,
      { timeoutMs: 15_000 },
    );
    r.ok("the row carries its task's title", task.ok);
    await snap(page, OUT, "1-seeded");

    httpReads.length = 0;

    // 2. A poller write: columns no list reads.
    let at = frames.length;
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
      "a poller write (waiting_for / last_viewed_at) sends the list nothing",
      listFramesSince(at),
      [],
    );

    // 3. A rename through the real endpoint: the Task column relabels.
    const renamed = `${seed.taskTitle} renamed`;
    at = frames.length;
    await renameTask(seed.taskId, renamed);
    const relabel = await waitFor(
      () => shownOf(page, [renamed]),
      (s) => s.length === 1,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "renaming the task relabels its conversation's row, live",
      relabel.ok,
      `after ${relabel.waitedMs}ms; ${listFramesSince(at).length} list frame(s)`,
    );

    // 4. The conversation retitled.
    const retitled = `${seed.user.title} retitled`;
    await db.query("UPDATE conversations SET title = $2 WHERE id = $1", [
      seed.user.id,
      retitled,
    ]);
    const retitle = await waitFor(
      () => shownOf(page, [retitled]),
      (s) => s.length === 1,
      { timeoutMs: 30_000 },
    );
    r.ok("retitling the conversation relabels it, live", retitle.ok);
    await snap(page, OUT, "2-after-edits");

    // 5. The task deleted: its conversations cascade away.
    await db.query("DELETE FROM tasks WHERE id = $1", [seed.taskId]);
    const gone = await waitFor(
      () => shownOf(page, [retitled]),
      (s) => s.length === 0,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "deleting the task removes its conversation, live",
      gone.ok,
      `after ${gone.waitedMs}ms`,
    );

    r.eq(
      "no HTTP read of conversations.all after the first listing (socket only)",
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
