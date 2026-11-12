/**
 * An error a visitor hits in the website's live demo reaches the site's own
 * server:
 *  1. on the website build, Enter equin and wait for the demo to run;
 *  2. raise an error while it runs (the page's crash collector catches it,
 *     as it does whatever the demo raises) — three times, the same error;
 *  3. the page sends ONE batch to POST /api/site-reports (its report
 *     channel, never /api/reports — the site's server has no reports engine)
 *     once the batch delay passes;
 *  4. after the intake's flush window, the site's `site_reports` table (read
 *     straight from the deploy's database) holds one row for it whose count
 *     is 3 — and its path is the page's pathname, no query.
 *  (The thrown errors are the point: the run's PAGEERROR lines are expected.)
 *
 * Manual only. Needs the website composition built from this checkout:
 *   ./equin build --composition website
 *   ./equin run plugins/apps/plugins/deploy/plugins/site-reports/e2e/demo-error-reported.ts --composition website
 */
import type { Request } from "playwright";
import {
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { answerTipsAsTheyShow } from "@plugins/hints/e2e";
import { SITE_REPORT_LIMITS } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";

const BOOT_TIMEOUT_MS = 60_000;

await withBrowser(async (h) => {
  const r = report(
    "site-reports: an error in the website's live demo reaches the site's server",
  );
  const { page } = await h.session();
  const posted: { path: string }[] = [];
  page.on("request", (req: Request) => {
    const { pathname } = new URL(req.url());
    if (pathname === "/api/site-reports" || pathname === "/api/reports") {
      posted.push({ path: pathname });
    }
  });

  // ── 1. the running demo ────────────────────────────────────────────
  await answerTipsAsTheyShow(page);
  await page.goto(pathUrl("/website?e2e=query-not-sent"), {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("button", { name: /Enter equin/ })
    .click({ timeout: BOOT_TIMEOUT_MS });
  const running = await waitFor(
    async () => page.locator('[data-app-embed="home"]').count(),
    (n) => n > 0,
    { timeoutMs: BOOT_TIMEOUT_MS },
  );
  r.ok("the demo runs", running.ok);

  // ── 2. the same error, three times, while the demo runs ────────────
  const nonce = `e2e_site_report_${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    // Thrown from a function named for this run: a crash's identity is its
    // type and top frames, so the run's own frame keeps it off earlier runs'
    // row (the message alone would fold into it).
    await page.evaluate((name) => {
      const raise = {
        [name]: () => {
          throw new Error(name);
        },
      }[name]!;
      setTimeout(raise);
    }, nonce);
  }
  await page.waitForTimeout(500);
  r.ok(
    "nothing is sent per occurrence: the channel batches",
    posted.length === 0,
    posted.map((p) => p.path).join(", "),
  );

  // ── 3. the batch goes out once its delay passes ─────────────────────
  // (Its pagehide twin is a keepalive send Playwright does not surface once
  // the page has unloaded; the batcher's unit test covers it.)
  const sent = await waitFor(
    async () => posted.length,
    (n) => n > 0,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "one batch goes to the site's intake, never /api/reports",
    sent.ok && posted.length === 1 && posted[0]!.path === "/api/site-reports",
    posted.map((p) => p.path).join(", "),
  );

  // ── 4. one row, its count, after the intake's flush ────────────────
  // Read straight from the deploy's database: the site's box has no route
  // that lists its reports (the computer reads them as a mirror change stream).
  const db = openDeployDb();
  onBeforeFinish(() => db.close());
  const listed = await waitFor(
    async () =>
      db.query<{ count: number; path: string }>(
        "SELECT count, path FROM site_reports WHERE position($1 in message) > 0",
        [nonce],
      ),
    (rows) => rows.length > 0,
    { timeoutMs: SITE_REPORT_LIMITS.windowMs + 30_000, intervalMs: 2_000 },
  );
  r.ok("the site's server holds one row for it", listed.value.length === 1);
  const row = listed.value[0];
  r.eq("its count is every occurrence", row?.count, 3);
  r.ok(
    "its path is the page's pathname, no query",
    (row?.path.startsWith("/website") ?? false) && !row?.path.includes("?"),
    row?.path,
  );
  await r.finish();
});
