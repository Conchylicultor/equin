/**
 * The events list is a LIVE window over `events` joined to its source
 * (research/2026-09-29-global-scoped-change-routing.md P4): a write to the
 * SOURCE reaches the list through the lookup's reverse route, gated on the
 * source columns the list reads — no revision tick, no refetch, no reload.
 *
 *  1. seeds a source (type `url`, enabled) and three events of it starting
 *     within the hour, so they sit at the top of the Upcoming view;
 *  2. a run's bookkeeping — `status` running → idle, a watermark — is written
 *     to the source: NO `events.list` frame arrives (the `unchanged` gate);
 *  3. the source's `enabled` flips off: its events leave the list; back on:
 *     they return (the default scope, routed as membership);
 *  4. its `config` changes: an `events.list` frame carries the new config onto
 *     the rows (`sourceConfig`), in place;
 *  5. the source is deleted: its events leave (the FK cascade, identity Ds);
 *  6. the page never reloaded.
 *
 * Every write is made in the database directly — out of band, so anything on
 * screen came off the server. The seeded rows are deleted at the end (also on
 * failure). Refuses main (it seeds rows into the deploy's database).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/events/plugins/event-list/e2e/list-live-verify.ts [--headed]
 */
import { randomBytes } from "node:crypto";
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

const OUT = arg("out") ?? "/tmp/events-list-live";
const db = openDeployDb();
const tag = randomBytes(3).toString("hex");
const SOURCE = `e2e-evs-${tag}`;
const titles = ["A", "B", "C"].map((x) => `e2e-live-${tag}-${x}`);

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  // Events cascade from their source.
  await db.query("DELETE FROM event_sources WHERE id LIKE 'e2e-evs-%'");
  await db.close();
}
onBeforeFinish(cleanup);

/** How many seeded titles are on screen. */
async function shown(page: Page): Promise<number> {
  return page.evaluate((wanted) => {
    let n = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (
        el.children.length === 0 &&
        wanted.includes(el.textContent?.trim() ?? "")
      ) {
        n++;
      }
    }
    return n;
  }, titles);
}

/** A frame of the events list's own resources (`events.list`, `:rows`, `:groups`). */
const LIST_FRAME = /"key":"events\.list(:[a-z]+)?"/;

try {
  await db.query("DELETE FROM event_sources WHERE id LIKE 'e2e-evs-%'");
  await db.query(
    `INSERT INTO event_sources (id, type, name, config, refresh, enabled, status)
     VALUES ($1, 'url', $2, $3::jsonb, 'manual', true, 'idle')`,
    [
      SOURCE,
      `E2E live ${tag}`,
      JSON.stringify({ url: "https://example.org/a" }),
    ],
  );
  for (const [i, title] of titles.entries()) {
    const startsAt = new Date(Date.now() + (20 + i) * 60_000).toISOString();
    await db.query(
      `INSERT INTO events (id, source_id, external_id, title, category, date, starts_at)
       VALUES ($1, $2, $1, $3, 'other', $4::jsonb, $5)`,
      [
        `${SOURCE}-${i}`,
        SOURCE,
        title,
        JSON.stringify({ kind: "once", startsAt }),
        startsAt,
      ],
    );
  }

  await withBrowser(async (h) => {
    const r = report("events list — a source write, routed live");
    const { page } = await h.session();
    // Every live frame the tab receives, as text: what reached the list.
    const frames: string[] = [];
    // Through the shared socket's tap: the socket lives in a SharedWorker, out
    // of `page.on("websocket")`'s reach.
    (await tapSharedSocket(page)).onFrame((f) => frames.push(f.data));
    const listFramesSince = (at: number) =>
      frames.slice(at).filter((f) => LIST_FRAME.test(f));

    await boot(page, pathUrl("/events/list"), {
      marker: 'button:has-text("Upcoming")',
      timeoutMs: 120_000,
      settleMs: 800,
    });
    const seeded = await waitFor(
      () => shown(page),
      (n) => n === 3,
      { timeoutMs: 30_000 },
    );
    r.eq("the three seeded events are listed", seeded.value, 3);
    await snap(page, OUT, "1-seeded");
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    // 2. A run's bookkeeping: columns the list never reads.
    let at = frames.length;
    await db.query(
      "UPDATE event_sources SET status = 'running', last_run_at = now() WHERE id = $1",
      [SOURCE],
    );
    await db.query(
      "UPDATE event_sources SET status = 'idle', last_fingerprint = 'fp', last_outcome = 'unchanged' WHERE id = $1",
      [SOURCE],
    );
    await page.waitForTimeout(2500);
    r.eq(
      "a status / watermark write sends the list nothing",
      listFramesSince(at),
      [],
    );
    r.eq("…and the rows stay", await shown(page), 3);

    // 3. The enabled flip: membership, through the reverse route.
    await db.query("UPDATE event_sources SET enabled = false WHERE id = $1", [
      SOURCE,
    ]);
    const gone = await waitFor(
      () => shown(page),
      (n) => n === 0,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "disabling the source drops its events, live",
      gone.ok,
      `${gone.value} left after ${gone.waitedMs}ms`,
    );
    await db.query("UPDATE event_sources SET enabled = true WHERE id = $1", [
      SOURCE,
    ]);
    const back = await waitFor(
      () => shown(page),
      (n) => n === 3,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "re-enabling it brings them back, live",
      back.ok,
      `${back.value} shown after ${back.waitedMs}ms`,
    );

    // 4. A config edit: the rows carry the source ref, refilled in place.
    at = frames.length;
    await db.query(
      "UPDATE event_sources SET config = $2::jsonb WHERE id = $1",
      [SOURCE, JSON.stringify({ url: "https://example.org/b" })],
    );
    const config = await waitFor(
      async () => listFramesSince(at),
      (fs) => fs.some((f) => f.includes("https://example.org/b")),
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a config edit reaches the listed rows (sourceConfig), live",
      config.ok,
      `${config.value.length} list frame(s) after ${config.waitedMs}ms`,
    );
    r.eq("…in place", await shown(page), 3);
    await snap(page, OUT, "2-after-edits");

    // 5. The source deleted: its events cascade away.
    await db.query("DELETE FROM event_sources WHERE id = $1", [SOURCE]);
    const deleted = await waitFor(
      () => shown(page),
      (n) => n === 0,
      { timeoutMs: 30_000 },
    );
    r.ok(
      "deleting the source removes its events, live",
      deleted.ok,
      `${deleted.value} left after ${deleted.waitedMs}ms`,
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
