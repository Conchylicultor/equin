/**
 * The homepage's live demo band, from a first visit (a fresh browser holds no
 * demo data):
 *  1. it opens on the gate (Enter equin), and nothing of the demo's host —
 *     its host module, its worker — is requested before the click;
 *  2. Enter grows the frame in place, out of the reading measure, and the
 *     boot screen's bar shows while the host starts;
 *  3. the demo runs (the embed renders) with Maximize and Reset demo under
 *     it — no Collapse / Expand: once entered, the frame stays grown;
 *  4. a move inside the demo (Home's Pages tile) is written into the
 *     homepage's URL, rewriting the current entry (framed);
 *  5. Maximize runs as a view transition and draws the demo over the tab's
 *     surface (above the site's header), with a "Press Esc to restore"
 *     notice; Esc brings it back into its frame, also as a view transition;
 *     Maximize again, then Back returns to the frame (Maximize is the page's
 *     own step); Restore (revealed at the top edge) also restores;
 *  6. a reload shows the gate again — the host now starting behind it, the
 *     data being stored — and Enter reopens the demo grown, on Pages, where
 *     the visitor was.
 * Screenshots of each step go to `--out`.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/live-demo.ts [--out /tmp/website-live-demo] [--headed]
 */
import type { Page, Request } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { answerTipsAsTheyShow } from "@plugins/hints/e2e";

const OUT = arg("out") ?? "/tmp/website-live-demo";
/** The demo's host: its module (`@browser-host/…`) and its worker tree. */
const HOST_REQUEST = /\/(artifacts\/[^/]*browser-host|artifacts\/worker-tree)/;
const BOOT_TIMEOUT_MS = 60_000;
/** The homepage URL's key holding the demo's location (`demo-place.ts`). */
const LOCATION_KEY = "view.website.demo=";
const FULL_KEY = "view.website.demo.full=1";

/** The page's URL path, decoded. */
function pathOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname);
}

async function urlSettles(
  r: Report,
  page: Page,
  name: string,
  ok: (path: string) => boolean,
): Promise<void> {
  const settled = await waitFor(async () => pathOf(page), ok, {
    timeoutMs: 5_000,
  });
  r.ok(name, settled.ok, settled.value);
}

/** Count the page's view transitions from now on (`viewTransitions`). */
async function countViewTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eTransitions: number };
    w.__e2eTransitions = 0;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((update?: ViewTransitionUpdateCallback) => {
      w.__e2eTransitions++;
      return start(update);
    }) as typeof document.startViewTransition;
  });
}

function viewTransitions(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __e2eTransitions: number }).__e2eTransitions,
  );
}

await withBrowser(async (h) => {
  const r = report("website: the homepage's live demo, downloaded on demand");
  const { page } = await h.session();
  const hostRequests: string[] = [];
  page.on("request", (req: Request) => {
    if (HOST_REQUEST.test(req.url())) hostRequests.push(req.url());
  });

  // ── 1. the gate ────────────────────────────────────────────────────
  // The demo is met fresh: its tips would cover the controls under the frame.
  await answerTipsAsTheyShow(page);
  await page.goto(pathUrl("/website"), { waitUntil: "domcontentloaded" });
  const band = page.locator("figure.website-demo").first();
  const frame = band.locator(".website-demo-frame").first();
  const gate = page.getByRole("button", { name: /Enter equin/ });
  await gate.waitFor({ timeout: BOOT_TIMEOUT_MS });
  await band.scrollIntoViewIfNeeded();
  const before = (await frame.boundingBox())?.width ?? 0;
  await snap(page, OUT, "1-gate");
  r.ok(
    "the band opens on the gate, and nothing of the demo's host was requested",
    hostRequests.length === 0,
    hostRequests.join(", "),
  );

  // ── 2. Enter grows the frame ───────────────────────────────────────
  await gate.click();
  const grown = await waitFor(
    async () => (await frame.boundingBox())?.width ?? 0,
    (w) => w > before + 100,
    { timeoutMs: 5_000 },
  );
  r.ok(
    "Enter grows the frame out of the reading measure",
    grown.ok,
    `${Math.round(before)} → ${Math.round(grown.value)} px`,
  );
  const bar = page.getByRole("progressbar").first();
  if (await bar.isVisible()) await snap(page, OUT, "2-starting");

  // ── 3. the running demo ────────────────────────────────────────────
  const running = await waitFor(
    async () => page.locator('[data-app-embed="home"]').count(),
    (n) => n > 0,
    { timeoutMs: BOOT_TIMEOUT_MS },
  );
  r.ok("the demo runs in the band, on Home", running.ok);
  r.ok(
    "the host was requested only after Enter",
    hostRequests.length > 0,
    `${hostRequests.length} request(s)`,
  );
  r.ok(
    "under it: Maximize and Reset demo, no Collapse / Expand",
    (await page.getByRole("button", { name: "Maximize" }).count()) === 1 &&
      (await page.getByRole("button", { name: "Reset demo" }).count()) === 1 &&
      (await page
        .getByRole("button", { name: /^(Collapse|Expand)$/ })
        .count()) === 0,
  );
  const grownWidth = (await frame.boundingBox())?.width ?? 0;
  r.ok(
    "the running demo is still grown",
    grownWidth > before + 100,
    `${Math.round(grownWidth)} px`,
  );
  await page.waitForTimeout(700);
  await snap(page, OUT, "3-running");

  // ── 4. a move inside is the homepage's URL ─────────────────────────
  const entries = await page.evaluate(() => history.length);
  await page
    .locator("[data-app-embed]")
    .first()
    .getByText("Pages", { exact: true })
    .first()
    .click();
  await page
    .locator('[data-app-embed="pages"]')
    .first()
    .waitFor({ timeout: BOOT_TIMEOUT_MS });
  await urlSettles(r, page, "the URL names the demo's place (Pages)", (p) =>
    p.includes(`${LOCATION_KEY}/pages`),
  );
  r.eq(
    "framed, the demo's moves add no history entry",
    await page.evaluate(() => history.length),
    entries,
  );

  // ── 5. Maximize, Esc, Back, Restore ────────────────────────────────
  await countViewTransitions(page);
  await page.getByRole("button", { name: "Maximize" }).click();
  const viewport = page.viewportSize();
  // Maximized, the demo is drawn over the tab's surface (above the site's
  // header), the frame keeping its place in the page.
  const overlay = page.locator("[data-website-demo-maximized]").first();
  const maximized = await waitFor(
    async () => (await overlay.boundingBox()) ?? null,
    (box) =>
      box !== null &&
      viewport !== null &&
      Math.abs(box.width - viewport.width) < 2 &&
      box.y < 2,
    { timeoutMs: 3_000 },
  );
  r.ok(
    "Maximize fills the tab, the site's header included",
    maximized.ok,
    JSON.stringify(maximized.value),
  );
  r.eq("Maximize: run as a view transition", await viewTransitions(page), 1);
  await urlSettles(r, page, "Maximize: the URL says so", (p) =>
    p.includes(FULL_KEY),
  );
  r.ok(
    "the maximized demo runs on Pages (the embed reopened where it was)",
    (await overlay.locator('[data-app-embed="pages"]').count()) > 0,
  );
  const notice = page.locator("[data-demo-esc-notice]");
  r.ok(
    "Maximize: a notice says Esc restores",
    /Press\s*Esc\s*to restore/.test((await notice.textContent()) ?? ""),
  );
  await snap(page, OUT, "4-maximized");
  const hidden = await waitFor(
    () => notice.isVisible(),
    (v) => !v,
    { timeoutMs: 8_000 },
  );
  r.ok("the notice hides on its own", hidden.ok);

  const restoredInFrame = async (name: string) => {
    const restored = await waitFor(
      async () => ({
        overlays: await overlay.count(),
        embeds: await frame.locator("[data-app-embed]").count(),
      }),
      (v) => v.overlays === 0 && v.embeds > 0,
      { timeoutMs: 3_000 },
    );
    r.ok(name, restored.ok, JSON.stringify(restored.value));
  };
  await page.mouse.click((viewport?.width ?? 1200) / 2, 300);
  await page.keyboard.press("Escape");
  await restoredInFrame("Esc puts the demo back in its frame");
  r.eq("Esc: run as a view transition", await viewTransitions(page), 2);
  await urlSettles(
    r,
    page,
    "Esc: the URL is framed again, on Pages",
    (p) => !p.includes(FULL_KEY) && p.includes(`${LOCATION_KEY}/pages`),
  );

  await page.getByRole("button", { name: "Maximize" }).click();
  await overlay.waitFor({ timeout: 3_000 });
  await page.goBack();
  await restoredInFrame("Back from maximized returns to the frame");

  await page.getByRole("button", { name: "Maximize" }).click();
  await overlay.waitFor({ timeout: 3_000 });
  await page.mouse.move((viewport?.width ?? 1200) / 2, 2);
  await page.getByRole("button", { name: "Restore" }).click();
  await restoredInFrame("Restore puts the demo back in its frame");

  // ── 6. a reload: the gate again, then back where the visitor was ───
  const requestedBefore = hostRequests.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await gate.waitFor({ timeout: BOOT_TIMEOUT_MS });
  r.ok("after a reload, the gate shows again", await gate.isVisible());
  const behind = await waitFor(
    async () => hostRequests.length,
    (n) => n > requestedBefore,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "after a reload, the host starts behind the gate (the data is stored)",
    behind.ok,
    `${behind.value - requestedBefore} request(s)`,
  );
  await band.scrollIntoViewIfNeeded();
  await gate.click();
  const reopened = await waitFor(
    async () => frame.locator('[data-app-embed="pages"]').count(),
    (n) => n > 0,
    { timeoutMs: BOOT_TIMEOUT_MS },
  );
  r.ok("after a reload, Enter reopens the demo on Pages", reopened.ok);
  r.ok(
    "after a reload, entering grows the frame",
    ((await frame.boundingBox())?.width ?? 0) > before + 100,
  );
  await page.waitForTimeout(700);
  await snap(page, OUT, "5-reloaded");
  await r.finish();
});
