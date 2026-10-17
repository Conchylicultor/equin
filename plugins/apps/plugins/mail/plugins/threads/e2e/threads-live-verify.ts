/**
 * The threads list is LIVE: a write to `mail_threads` reaches the open list
 * without a reload, a refetch, or a revision tick.
 *
 *  1. seeds three synthetic Inbox threads for the connected account (A newest,
 *     then B, then C) — a worktree carries no mail corpus, so the script brings
 *     its own (`fixture.ts`; it refuses main);
 *  2. opens the Inbox tab and asserts they render in date order;
 *  3. gives C a new message (`last_message_at = now()`) in the database — C
 *     must move above A, in place;
 *  4. moves B to Spam (`label_ids = ["SPAM"]`) — B must leave the Inbox, in
 *     place;
 *  5. marks A read — A's row must stop rendering bold;
 *  6. deletes the seeded threads (also on failure, via `onBeforeFinish`).
 *
 * Each write goes straight to the database, as sync's would: the change feed is
 * what must carry it to the tab. The page is never reloaded between steps.
 *
 * Manual only — nothing runs this automatically.
 *   ./singularity run plugins/apps/plugins/mail/plugins/threads/e2e/threads-live-verify.ts [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  onBeforeFinish,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openThreadFixture } from "./fixture";

const OUT = arg("out") ?? "/tmp/threads-live";
const BOOT_TIMEOUT_MS = 120_000;
const TABS_READY = 'button[data-tooltip="Trash"]';

/** The seeded threads' ids, top to bottom, as the list renders them now. */
async function renderedOrder(
  page: Page,
  ids: readonly string[],
): Promise<string[]> {
  const rows = await page.locator("[data-thread-id]").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-thread-id") ?? "",
      top: el.getBoundingClientRect().top,
    })),
  );
  return rows
    .filter((r) => ids.includes(r.id))
    .sort((a, b) => a.top - b.top)
    .map((r) => r.id);
}

const fixture = await openThreadFixture();
onBeforeFinish(() => fixture.cleanup());

// `finish()` exits through the teardown hook; a throw exits through `finally`.
try {
  await withBrowser(async (h) => {
    const r = report("mail threads — the list follows the database, live");
    r.note(
      `account ${fixture.accountId}: ${fixture.existing} existing thread(s)`,
    );
    const a = await fixture.seed({
      name: "a",
      labels: ["INBOX"],
      minutesAgo: 1,
    });
    const b = await fixture.seed({
      name: "b",
      labels: ["INBOX"],
      minutesAgo: 2,
    });
    const c = await fixture.seed({
      name: "c",
      labels: ["INBOX"],
      minutesAgo: 3,
    });
    const ids = [a.id, b.id, c.id];

    const { page } = await h.session();
    await boot(page, pathUrl("/mail/threads"), {
      marker: TABS_READY,
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 500,
    });
    // Clicking the ACTIVE tab opens its rename menu; Escape closes it either way.
    await page.locator('button[data-tooltip="Inbox"]').first().click();
    await page.keyboard.press("Escape");

    // ---- 2. the seeded threads render, newest first -----------------------
    const initial = await waitFor(
      () => renderedOrder(page, ids),
      (order) => order.length === 3,
      { timeoutMs: 60_000 },
    );
    r.eq("Inbox renders the seeded threads newest-first", initial.value, [
      a.id,
      b.id,
      c.id,
    ]);
    await snap(page, OUT, "seeded");

    // A marker on the document: a reload would drop it, so its survival proves
    // every step below happened in place.
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    // ---- 3. a new message on C moves it to the top -------------------------
    await fixture.exec(
      "UPDATE mail_threads SET last_message_at = now(), message_count = 2 WHERE id = $1",
      [c.id],
    );
    const moved = await waitFor(
      () => renderedOrder(page, ids),
      (order) => order[0] === c.id,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a new message moves the thread to the top, without a reload",
      moved.ok,
      `order ${JSON.stringify(moved.value)} after ${moved.waitedMs}ms`,
    );
    r.note(`reorder landed after ${moved.waitedMs}ms`);

    // ---- 4. a label change drops B out of Inbox ----------------------------
    await fixture.exec(
      `UPDATE mail_threads SET label_ids = '["SPAM"]'::jsonb WHERE id = $1`,
      [b.id],
    );
    const left = await waitFor(
      () => renderedOrder(page, ids),
      (order) => !order.includes(b.id),
      { timeoutMs: 30_000 },
    );
    r.ok(
      "moving a thread to Spam drops it from Inbox, without a reload",
      left.ok,
      `order ${JSON.stringify(left.value)} after ${left.waitedMs}ms`,
    );
    r.eq("the rest keep their order", left.value, [c.id, a.id]);

    // ---- 5. marking A read un-bolds its row --------------------------------
    const boldOf = async (id: string): Promise<boolean> =>
      page
        .locator(`[data-thread-id="${id}"] .font-semibold`)
        .count()
        .then((n) => n > 0);
    r.ok("A starts unread (bold)", await boldOf(a.id));
    await fixture.exec("UPDATE mail_threads SET unread = false WHERE id = $1", [
      a.id,
    ]);
    const read = await waitFor(
      () => boldOf(a.id),
      (bold) => !bold,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "marking a thread read updates its row in place",
      read.ok,
      `after ${read.waitedMs}ms`,
    );

    r.ok(
      "the page was never reloaded",
      await page.evaluate(
        () =>
          (window as unknown as { __noReload?: boolean }).__noReload === true,
      ),
    );
    await snap(page, OUT, "after");
    await r.finish();
  });
} finally {
  await fixture.cleanup();
}
