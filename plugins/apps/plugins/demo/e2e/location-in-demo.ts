/**
 * Where the visitor is inside the demo is the page's own URL
 * (`apps/demo/shell`'s routes). In `/demo`, in one fresh browser context, it:
 *
 *  1. opens the bare `/demo`: the demo starts on Home (the app gallery), and
 *     the URL settles on `/demo/at/home`, framed under the caption bar;
 *  2. opens Pages and creates a page there: the URL follows the embed
 *     (`/demo/at/pages/…`), rewriting the current history entry (framed, the
 *     demo's moves are not the page's Back steps); a reload reopens the demo
 *     on that same page;
 *  3. ⌘-clicks the launcher mark (a link to the home app): a NEW tab opens the
 *     demo full screen there (`/demo/at/home;full=1`, no caption bar) — not
 *     the real app — and its Pages lists the page the first tab created (both
 *     tabs on the demo's one SharedWorker); full screen, the demo's moves are
 *     the tab's history: Back from Pages returns the demo to Home, Forward
 *     to Pages;
 *  4. Full screen, then Exit full screen (revealed by the pointer at the top
 *     edge): the URL gains and loses `;full=1`, and the embed stays the same
 *     element throughout (the demo never remounts);
 *  5. Full screen again, then another page from the sidebar: Back reopens
 *     the created page, a second Back leaves full screen for the frame, Forward comes
 *     back full screen — the same embed throughout;
 *  6. the desktop, full screen: Pages then Sonata from the shelf, each a
 *     window; Back focuses the Pages window again and Forward the Sonata one
 *     — the URL following — with no window added or turned into another.
 *
 * And, throughout: no `/api/…` request left for the page's origin but the
 * sanctioned telemetry routes (`no-leak.ts`'s list), no page or console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/location-in-demo.ts [--out /tmp/demo-location] [--headed]
 */
import type { Page, Request } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  waitForNetworkIdle,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  createPage,
  embedRoot,
  listed,
  onDemoPage,
  RENDER_TIMEOUT_MS,
  showsApp,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-location";

/** The page-origin `/api` routes a demo may still call — `no-leak.ts`'s list (D3). */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  /^\/api\/icons\/(sprite|symbols)\//,
  /^\/api\/health(\/ready)?$/,
];

/**
 * Record every unsanctioned page-origin `/api` request `page` sends while
 * `gate.on` — off while a page boots (its own chrome's reads, as `no-leak.ts`
 * starts recording once the demo is up).
 */
function watchLeaks(page: Page, leaked: string[], gate: { on: boolean }): void {
  page.on("request", (req: Request) => {
    if (!gate.on) return;
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return;
    if (!SANCTIONED.some((re) => re.test(url.pathname)))
      leaked.push(`${req.method()} ${url.pathname}`);
  });
}

/** The page's URL path, decoded (`;full=1` and the location, readable). */
function pathOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname);
}

/** Wait until the page's URL path satisfies `ok`. */
async function urlSettles(
  r: Report,
  page: Page,
  name: string,
  ok: (path: string) => boolean,
): Promise<string> {
  const settled = await waitFor(async () => pathOf(page), ok, {
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  r.ok(name, settled.ok, settled.value);
  return settled.value;
}

/** The title the open page-detail pane shows, once it shows `title`. */
async function showsPage(
  r: Report,
  page: Page,
  name: string,
  title: string,
): Promise<void> {
  const field = embedRoot(page)
    .locator('[data-pane-id="page-detail"]')
    .last()
    .locator('input[aria-label="Page title"]')
    .first();
  const settled = await waitFor(
    async () => ((await field.count()) > 0 ? await field.inputValue() : null),
    (value) => value === title,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(name, settled.ok, JSON.stringify(settled.value));
}

/** How many entries the tab's session history holds. */
function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

/** Whether the caption bar (its Reset demo button) is on the page. */
async function framed(page: Page): Promise<boolean> {
  return (await page.getByRole("button", { name: "Reset demo" }).count()) > 0;
}

/** Tag the embed's element, so a later read can tell it is the same one. */
async function tagEmbed(page: Page): Promise<void> {
  await embedRoot(page).evaluate((el) => {
    el.setAttribute("data-e2e-same-embed", "");
  });
}

async function sameEmbed(page: Page): Promise<boolean> {
  return (
    (await page.locator("[data-app-embed][data-e2e-same-embed]").count()) > 0
  );
}

await withBrowser(async (h) => {
  const r = report("demo: the page's URL is where the visitor is");
  const { page, context } = await h.session();
  const leaked: string[] = [];
  const gate = { on: false };
  watchLeaks(page, leaked, gate);
  const TITLE = `Here ${Date.now().toString(36)}`;

  // ── 1. /demo starts on Home ───────────────────────────────────────────
  await boot(page, pathUrl("/demo"), { marker: '[data-app-embed="home"]' });
  await showsApp(r, page, "the demo starts on Home (the app gallery)", "home");
  await urlSettles(
    r,
    page,
    "the URL settles on /demo/at/home",
    (p) => p === "/demo/at/home",
  );
  r.ok("it opens framed, under the caption bar", await framed(page));
  await waitForNetworkIdle(page);
  gate.on = true;
  await snap(page, OUT, "1-home");
  const framedEntries = await historyLength(page);

  // ── 2. the URL follows the embed; a reload comes back to it ───────────
  // Home IS the app gallery: Pages is one of its tiles.
  await embedRoot(page).getByText("Pages", { exact: true }).first().click();
  await showsApp(r, page, "Home's Pages tile opens Pages", "pages");
  await createPage(page, TITLE);
  await showsPage(r, page, "the created page is open", TITLE);
  const at = await urlSettles(
    r,
    page,
    "the URL names the page inside Pages",
    (p) => p.startsWith("/demo/at/pages/") && !p.includes(";full"),
  );
  r.eq(
    "framed, the demo's moves add no history entry",
    await historyLength(page),
    framedEntries,
  );
  gate.on = false;
  await page.reload();
  await showsApp(r, page, "after a reload, the demo reopens on Pages", "pages");
  await showsPage(r, page, "after a reload, the same page is open", TITLE);
  r.eq("after a reload, the URL is unchanged", pathOf(page), at);
  r.ok("after a reload, still framed", await framed(page));
  await waitForNetworkIdle(page);
  gate.on = true;
  await snap(page, OUT, "2-reloaded");

  // ── 3. ⌘-click → a new tab, the demo full screen at that place ─────────
  await listed(r, page, "the sidebar lists the created page", TITLE, "some");
  const opened = context.waitForEvent("page", { timeout: RENDER_TIMEOUT_MS });
  // The launcher mark is a link to the home app: ⌘-click opens it in a new
  // browser tab. (A sidebar row's ⌘-click is multi-select, not a link.)
  await embedRoot(page)
    .getByRole("button", { name: "All apps" })
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  const tab = await opened;
  const tabGate = { on: false };
  watchLeaks(tab, leaked, tabGate);
  await tab.waitForLoadState();
  await urlSettles(
    r,
    tab,
    "the new tab opens the demo at Home, full screen",
    (p) => p === "/demo/at/home;full=1",
  );
  await showsApp(r, tab, "the new tab's demo shows Home", "home");
  r.ok("the new tab is full screen: no caption bar", !(await framed(tab)));
  // The new tab's page booted on its own: its chrome's reads settle first.
  await waitForNetworkIdle(tab);
  tabGate.on = true;
  r.ok("the first tab did not move", pathOf(page) === at, pathOf(page));
  await embedRoot(tab).getByText("Pages", { exact: true }).first().click();
  await showsApp(r, tab, "the new tab opens Pages", "pages");
  await listed(
    r,
    tab,
    "the new tab lists the page the first tab created (same data)",
    TITLE,
    "some",
  );
  await urlSettles(
    r,
    tab,
    "the new tab's URL follows it, still full screen",
    (p) => p.startsWith("/demo/at/pages") && p.endsWith(";full=1"),
  );
  await snap(tab, OUT, "3-new-tab");
  // Full screen, the demo is the tab: Back and Forward step through its moves.
  await tab.goBack();
  await urlSettles(
    r,
    tab,
    "full screen, Back returns the URL to Home",
    (p) => p === "/demo/at/home;full=1",
  );
  await showsApp(r, tab, "full screen, Back returns the demo to Home", "home");
  await tab.goForward();
  await urlSettles(
    r,
    tab,
    "full screen, Forward returns the URL to Pages",
    (p) => p.startsWith("/demo/at/pages") && p.endsWith(";full=1"),
  );
  await showsApp(r, tab, "full screen, Forward reopens Pages", "pages");
  await tab.close();

  // ── 4. Full screen and back, the embed never remounting ────────────────
  await tagEmbed(page);
  await page.getByRole("button", { name: "Full screen" }).first().click();
  await urlSettles(r, page, "Full screen: the URL gains ;full=1", (p) =>
    p.endsWith(";full=1"),
  );
  r.ok("Full screen: no caption bar", !(await framed(page)));
  r.ok("Full screen: the same embed (no remount)", await sameEmbed(page));
  const exit = page.getByRole("button", { name: "Exit full screen" });
  const strip = page.locator("[data-demo-exit-full-screen]");
  const box = await strip.boundingBox();
  r.ok(
    "Full screen: the exit strip sits at the top edge",
    box !== null && box.y < 4,
    JSON.stringify(box),
  );
  if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + 2);
  await exit.waitFor({ state: "visible", timeout: RENDER_TIMEOUT_MS });
  await snap(page, OUT, "4-full-screen");
  await exit.click();
  await urlSettles(
    r,
    page,
    "Exit full screen: the URL loses ;full=1",
    (p) => p === at,
  );
  r.ok("Exit full screen: framed again", await framed(page));
  r.ok("Exit full screen: still the same embed", await sameEmbed(page));
  await showsPage(r, page, "the page is still open", TITLE);

  // ── 5. Back / Forward full screen, and out of it ──────────────────────
  await page.getByRole("button", { name: "Full screen" }).first().click();
  await urlSettles(r, page, "Full screen again", (p) => p === `${at};full=1`);
  // Another page of the sidebar: a move inside Pages.
  await embedRoot(page).getByText("Journal", { exact: true }).first().click();
  await showsPage(r, page, "full screen, the sidebar opens Journal", "Journal");
  await urlSettles(
    r,
    page,
    "full screen, the URL follows to Journal",
    (p) =>
      p.startsWith("/demo/at/pages/") &&
      p.endsWith(";full=1") &&
      p !== `${at};full=1`,
  );
  await page.goBack();
  await urlSettles(
    r,
    page,
    "Back: the URL returns to the page, full screen",
    (p) => p === `${at};full=1`,
  );
  await showsPage(r, page, "Back: the demo reopens the page", TITLE);
  r.ok("Back: still full screen", !(await framed(page)));
  await page.goBack();
  await urlSettles(r, page, "Back again: out of full screen", (p) => p === at);
  r.ok("Back again: framed", await framed(page));
  await page.goForward();
  await urlSettles(
    r,
    page,
    "Forward: full screen again",
    (p) => p === `${at};full=1`,
  );
  await showsPage(r, page, "Forward: the page is still open", TITLE);
  r.ok("Back / Forward: still the same embed", await sameEmbed(page));
  await snap(page, OUT, "5-back-forward");

  // ── 6. the desktop, full screen: Back / Forward move between windows ──
  gate.on = false;
  await page.goto(pathUrl("/demo/at/desktop;full=1"));
  await waitForNetworkIdle(page);
  gate.on = true;
  const desk = embedRoot(page);
  const windows = () =>
    desk
      .locator("[data-floating-window-id]")
      .evaluateAll((els) =>
        [
          ...new Set(
            els.map((el) => el.getAttribute("data-floating-window-id")),
          ),
        ].sort(),
      );
  const shelf = (name: string) =>
    desk.getByRole("button", { name, exact: true }).last().click();
  await shelf("Pages");
  await urlSettles(
    r,
    page,
    "desktop: Pages opens a window",
    (p) => p === "/demo/at/desktop/pages;full=1",
  );
  await shelf("Sonata");
  await urlSettles(
    r,
    page,
    "desktop: Sonata opens a window",
    (p) => p === "/demo/at/desktop/sonata;full=1",
  );
  const open = await windows();
  await page.goBack();
  await urlSettles(
    r,
    page,
    "desktop: Back returns to the Pages window",
    (p) => p === "/demo/at/desktop/pages;full=1",
  );
  r.eq("desktop: Back keeps every window as it was", await windows(), open);
  await page.goForward();
  await urlSettles(
    r,
    page,
    "desktop: Forward returns to the Sonata window",
    (p) => p === "/demo/at/desktop/sonata;full=1",
  );
  r.eq("desktop: Forward keeps every window as it was", await windows(), open);
  r.ok(
    "desktop: Pages and Sonata are both still open",
    (await desk.getByText("Library", { exact: true }).count()) > 0 &&
      (await desk.getByText("Demo's pages", { exact: true }).count()) > 0,
  );
  await snap(page, OUT, "6-desktop-back-forward");

  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  r.eq("no unsanctioned /api request left for the page's origin", leaked, []);
  await r.finish();
});
