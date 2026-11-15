/**
 * The homepage's live demo band and the demo page, from a first visit (a
 * fresh browser holds no demo data):
 *  1. it opens on the gate (Enter equin), and nothing of the demo's host —
 *     its host module, its worker — is requested before the click;
 *  2. Enter grows the frame in place, out of the reading measure, and the
 *     boot screen's bar shows while the host starts;
 *  3. the demo runs (the embed renders) with Maximize and Reset demo under
 *     it — no Collapse / Expand: once entered, the frame stays grown;
 *  4. a move inside the framed demo (Home's Pages tile) leaves the
 *     homepage's URL alone (`/about`) and adds no history entry;
 *  5. Maximize runs as a view transition onto the demo page
 *     (`/about/demo/at/pages`): the demo alone fills the tab, nothing of the
 *     homepage mounted, on the same server (no host restart), with a "Press
 *     Esc to restore" notice; Esc goes back to the homepage's frame, also as
 *     a view transition, on Pages; Maximize again, then Back returns to the
 *     frame; Restore (revealed at the top edge) also returns;
 *  6. the homepage reloaded shows the gate again (its URL names no place);
 *  7. the demo page loaded fresh resumes with no gate, on Pages, and loads
 *     nothing of the homepage (no hero film);
 *  8. a second tab opened at that URL joins the demo — no gate.
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
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { answerTipsAsTheyShow } from "@plugins/hints/e2e";
import { demoPagePath } from "@plugins/apps/plugins/website/plugins/live-demo/core";

const OUT = arg("out") ?? "/tmp/website-live-demo";
/** The demo's host: its module (`@browser-host/…`) and its worker tree. */
const HOST_REQUEST = /\/(artifacts\/[^/]*browser-host|artifacts\/worker-tree)/;
const BOOT_TIMEOUT_MS = 60_000;
/** The demo page at Pages. */
const DEMO_PAGES = demoPagePath("/pages");
/** The hero film, which only the homepage loads. */
const HERO_FILM = /website-media\/.*\.mp4/;

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
  await page.goto(pathUrl("/about"), { waitUntil: "domcontentloaded" });
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

  // ── 4. a move inside the frame leaves the homepage's URL alone ─────
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
  r.eq("framed, the URL stays the homepage's", pathOf(page), "/about");
  r.eq(
    "framed, the demo's moves add no history entry",
    await page.evaluate(() => history.length),
    entries,
  );

  // ── 5. Maximize (the demo page), Esc, Back, Restore ────────────────
  const hostsBefore = hostRequests.length;
  await countViewTransitions(page);
  await page.getByRole("button", { name: "Maximize" }).click();
  const viewport = page.viewportSize();
  const demoPage = page.locator('[data-demo-target="page"]').first();
  const maximized = await waitFor(
    async () => (await demoPage.boundingBox()) ?? null,
    (box) =>
      box !== null &&
      viewport !== null &&
      Math.abs(box.width - viewport.width) < 2 &&
      box.y < 2,
    { timeoutMs: 3_000 },
  );
  r.ok(
    "Maximize opens the demo page, the demo filling the tab",
    maximized.ok,
    JSON.stringify(maximized.value),
  );
  r.eq("Maximize: run as a view transition", await viewTransitions(page), 1);
  await urlSettles(
    r,
    page,
    "Maximize: the URL is the demo page, at Pages",
    (p) => p === DEMO_PAGES,
  );
  r.eq(
    "the demo page mounts nothing of the homepage",
    await page.locator("figure.website-demo, video").count(),
    0,
  );
  r.ok(
    "the maximized demo runs on Pages (the embed reopened where it was)",
    (await demoPage.locator('[data-app-embed="pages"]').count()) > 0,
  );
  r.eq(
    "the demo's server kept running (no host request on Maximize)",
    hostRequests.length,
    hostsBefore,
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
        path: pathOf(page),
        pages: await demoPage.count(),
        embeds: await frame.locator('[data-app-embed="pages"]').count(),
      }),
      (v) => v.path === "/about" && v.pages === 0 && v.embeds > 0,
      { timeoutMs: 3_000 },
    );
    r.ok(name, restored.ok, JSON.stringify(restored.value));
  };
  await page.mouse.click((viewport?.width ?? 1200) / 2, 300);
  await page.keyboard.press("Escape");
  await restoredInFrame("Esc returns to the homepage's frame, on Pages");
  r.eq("Esc: run as a view transition", await viewTransitions(page), 2);

  await page.getByRole("button", { name: "Maximize" }).click();
  await demoPage.waitFor({ timeout: 3_000 });
  await page.goBack();
  await restoredInFrame("Back from the demo page returns to the frame");

  await page.getByRole("button", { name: "Maximize" }).click();
  await demoPage.waitFor({ timeout: 3_000 });
  await page.mouse.move((viewport?.width ?? 1200) / 2, 2);
  await page.getByRole("button", { name: "Restore" }).click();
  await restoredInFrame("Restore returns to the frame");
  r.eq(
    "the server ran through every switch (no host request)",
    hostRequests.length,
    hostsBefore,
  );

  // ── 6. the homepage reloaded: the gate again ────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  const gated = await waitFor(
    async () => gate.count(),
    (n) => n > 0,
    { timeoutMs: BOOT_TIMEOUT_MS },
  );
  r.ok(
    "after a reload, the homepage shows the gate (its URL names no place)",
    gated.ok,
  );
  await snap(page, OUT, "5-reloaded");

  // ── 7. the demo page loaded fresh: no gate, nothing of the homepage ──
  const fresh = await page.context().newPage();
  const films: string[] = [];
  fresh.on("request", (req: Request) => {
    if (HERO_FILM.test(req.url())) films.push(req.url());
  });
  await fresh.goto(pathUrl(DEMO_PAGES), { waitUntil: "domcontentloaded" });
  const inPlace = await waitFor(
    async () => ({
      gates: await fresh.locator('[data-demo-boot="gate"]').count(),
      embeds: await fresh
        .locator('[data-demo-target="page"] [data-app-embed="pages"]')
        .count(),
    }),
    (v) => v.gates > 0 || v.embeds > 0,
    { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 20 },
  );
  r.ok(
    "the demo page resumes on Pages with no gate",
    inPlace.ok && inPlace.value.gates === 0 && inPlace.value.embeds > 0,
    JSON.stringify(inPlace.value),
  );
  r.eq(
    "the demo page loads nothing of the homepage",
    {
      bands: await fresh.locator("figure.website-demo, video").count(),
      films: films.length,
    },
    { bands: 0, films: 0 },
  );
  await snap(fresh, OUT, "6-demo-page");

  // ── 8. a second tab at the demo page: it joins, no gate ─────────────
  const second = await page.context().newPage();
  await second.goto(pathUrl(DEMO_PAGES), { waitUntil: "domcontentloaded" });
  const joined = await waitFor(
    async () => ({
      gates: await second.locator('[data-demo-boot="gate"]').count(),
      embeds: await second
        .locator('[data-demo-target="page"] [data-app-embed="pages"]')
        .count(),
    }),
    (v) => v.gates > 0 || v.embeds > 0,
    { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 20 },
  );
  r.ok(
    "a second tab joins the demo, with no gate",
    joined.ok && joined.value.gates === 0 && joined.value.embeds > 0,
    JSON.stringify(joined.value),
  );
  await snap(second, OUT, "7-joined");
  await second.close();
  await fresh.close();
  await r.finish();
});
