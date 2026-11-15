/**
 * What a notification arriving on a VISIBLE page leaves behind, per arrival.
 *
 * An arrival is an announcement (`shell/toast` § Announcements): it is
 * toasted only on a page on screen, and leaves on its own after the
 * announcement duration whatever its variant — the bell keeps its row and the
 * unread badge. Before that rule an error arrival stayed until dismissed, so a
 * tab left on screen kept one custom toast (its own React root, listeners,
 * theme-scope styles) per error notification, ~20 an hour on main.
 *
 * One iteration: write an ERROR notification over the page's own context, wait
 * for its toast to appear, park the pointer away from the stack (hovering it
 * pauses sonner's timers), and wait past the announcement duration. The leak
 * verdict (`runLeakTest`, e2e-harness) is judged over run 2; the script also
 * fails when a toast is still mounted after its time.
 *
 * WRITES: one error notification per iteration in this worktree (audience
 * user, category other); a `finally` dismisses all of them.
 *
 * Usage:
 *   ./equin run plugins/shell/plugins/notifications/e2e/arrival-toast-leak.ts \
 *     [--iterations 10] [--out "$EQUIN_SCRATCH/arrival-leak"] [--no-record]
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arg,
  leakReportText,
  numArg,
  pageUrl,
  pathUrl,
  report,
  runLeakTest,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  waitFor,
  waitForNetworkIdle,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { notificationIdKind } from "@plugins/shell/plugins/notifications/core";
import type { Page } from "playwright";

const iterations = numArg("iterations", 10);
const out =
  arg("out") ?? join(mkdtempSync(join(tmpdir(), "arrival-leak-")), "leak");
/** Past the announcement duration (4 s) and sonner's exit animation. */
const LINGER_MS = 6000;
const TOAST = '[data-testid="notification-toast"]';

const r = report("Notifications · an error arrival's toast leaves on its own");

async function post(page: Page, path: string, data?: unknown): Promise<void> {
  const res = await page.request.post(pathUrl(path), { data: data ?? {} });
  if (!res.ok()) throw new Error(`POST ${path} — ${res.status()}`);
}

let seq = 0;
const arrive = async (page: Page) => {
  const before = await page.locator(TOAST).count();
  await post(page, "/api/notifications", {
    id: notificationIdKind.mint(),
    type: "e2e-arrival",
    category: "other",
    title: `e2e arrival #${++seq}`,
    description: "seeded by arrival-toast-leak.ts",
    variant: "error",
    audience: "user",
  });
  const shown = await waitFor(
    () => page.locator(TOAST).count(),
    (n) => n > before,
    { timeoutMs: 10_000, intervalMs: 100 },
  );
  if (!shown.ok)
    throw new Error(`arrival #${seq}: no toast after ${shown.waitedMs} ms`);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(LINGER_MS);
};

console.log(`url:   ${pageUrl()}`);
console.log(`out:   ${out}-*`);

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pageUrl(), { waitUntil: "domcontentloaded" });
  await waitForNetworkIdle(page);
  try {
    const leak = await runLeakTest(page, {
      step: arrive,
      iterations,
      warmup: 1,
      settleMs: 1000,
      out,
    });
    console.log("");
    console.log(leakReportText(leak));
    console.log("");
    for (const c of leak.verdict.checks) r.ok(c.name, c.ok, c.detail);
    const left = await page.locator(TOAST).count();
    r.ok(
      "no arrival toast still mounted after its time",
      left === 0,
      `${left} notification toast(s) mounted after ${seq} arrivals`,
    );
  } finally {
    await post(page, "/api/notifications/dismiss-all");
  }
});
await r.finish();
