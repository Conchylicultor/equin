/**
 * Where the visitor is inside the demo is the page's own URL
 * (`apps/demo/shell`'s routes). In `/demo`, in one fresh browser context, it:
 *
 *  1. opens the bare `/demo`: the demo starts on Home (the app gallery), and
 *     the URL settles on `/demo/at/home`, framed under the caption bar;
 *  2. opens Pages and creates a page there: the URL follows the embed
 *     (`/demo/at/pages/…`), rewriting the current history entry (framed, the
 *     demo's moves are not the page's Back steps); a reload reopens the demo
 *     on that same page, once the visitor enters it again (the gate shows on
 *     every visit);
 *  3. ⌘-clicks the launcher mark (a link to the home app): a NEW tab opens the
 *     demo maximized there (`/demo/at/home;full=1`, no caption bar) — not
 *     the real app — joining it with no second Enter equin (the visitor is
 *     in the demo in the first tab), and its Pages lists the page the first tab created (both
 *     tabs on the demo's one SharedWorker); maximized, the demo's moves are
 *     the tab's history: Back from Pages returns the demo to Home, Forward
 *     to Pages;
 *  4. Maximize, then Restore (revealed by the pointer at the top
 *     edge): each runs as a view transition, maximized a "Press Esc to
 *     restore" notice shows and then hides on its own, the URL gains and
 *     loses `;full=1`, and the embed stays the same element throughout (the
 *     demo never remounts);
 *  5. Maximize again, then another page from the sidebar: Back reopens
 *     the created page, a second Back leaves maximized for the frame, Forward comes
 *     back maximized — the same embed throughout; Esc in the page's title
 *     field stays the field's (still maximized), and Esc outside a field
 *     restores;
 *  6. the desktop, maximized, opened fresh (no other tab in the demo): its
 *     gate shows maximized, no caption bar; then Pages then Sonata from the shelf, each a
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
import { shownWindowIds } from "@plugins/apps/plugins/desktop/plugins/windows/e2e";
import {
  arg,
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
  bootDemo,
  enterDemo,
  ENTER_DEMO,
  joinDemo,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-location";
/** The framed page's caption bar (`demo-at.tsx`'s caption): absent maximized. */
const CAPTION_TEXT = "running in this page on made-up data";

/** The page-origin `/api` routes a demo may still call — `no-leak.ts`'s list (D3). */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  // A sprite the PAGE's chrome wears, read by the page's sprite host from the
  // page's server (`ui/icons/sprites`) — e.g. the hints stage's Rounded style,
  // drawn over the demo when one of its tips shows. Formerly /api/icons/….
  /^\/api\/resources\/icons\.sprite$/,
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
  await bootDemo(page, pathUrl("/demo"), { marker: '[data-app-embed="home"]' });
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
  await enterDemo(page, { marker: "[data-app-embed]" });
  await showsApp(r, page, "after a reload, the demo reopens on Pages", "pages");
  await showsPage(r, page, "after a reload, the same page is open", TITLE);
  r.eq("after a reload, the URL is unchanged", pathOf(page), at);
  r.ok("after a reload, still framed", await framed(page));
  await waitForNetworkIdle(page);
  gate.on = true;
  await snap(page, OUT, "2-reloaded");

  // ── 3. ⌘-click → a new tab, the demo maximized at that place ─────────
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
  r.ok(
    "the new tab joins the running demo with no second Enter equin",
    await joinDemo(tab, { marker: "[data-app-embed]" }),
  );
  await urlSettles(
    r,
    tab,
    "the new tab opens the demo at Home, maximized",
    (p) => p === "/demo/at/home;full=1",
  );
  await showsApp(r, tab, "the new tab's demo shows Home", "home");
  r.ok("the new tab is maximized: no caption bar", !(await framed(tab)));
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
    "the new tab's URL follows it, still maximized",
    (p) => p.startsWith("/demo/at/pages") && p.endsWith(";full=1"),
  );
  await snap(tab, OUT, "3-new-tab");
  // Maximized, the demo is the tab: Back and Forward step through its moves.
  await tab.goBack();
  await urlSettles(
    r,
    tab,
    "maximized, Back returns the URL to Home",
    (p) => p === "/demo/at/home;full=1",
  );
  await showsApp(r, tab, "maximized, Back returns the demo to Home", "home");
  await tab.goForward();
  await urlSettles(
    r,
    tab,
    "maximized, Forward returns the URL to Pages",
    (p) => p.startsWith("/demo/at/pages") && p.endsWith(";full=1"),
  );
  await showsApp(r, tab, "maximized, Forward reopens Pages", "pages");
  await tab.close();

  // ── 4. Maximize and back, the embed never remounting ────────────────
  await tagEmbed(page);
  await countViewTransitions(page);
  await page.getByRole("button", { name: "Maximize" }).first().click();
  await urlSettles(r, page, "Maximize: the URL gains ;full=1", (p) =>
    p.endsWith(";full=1"),
  );
  r.ok("Maximize: no caption bar", !(await framed(page)));
  r.ok("Maximize: the same embed (no remount)", await sameEmbed(page));
  r.eq("Maximize: run as a view transition", await viewTransitions(page), 1);
  const notice = page.locator("[data-demo-esc-notice]");
  r.ok(
    "Maximize: a notice says Esc restores",
    /Press\s*Esc\s*to restore/.test((await notice.textContent()) ?? ""),
  );
  await snap(page, OUT, "4-maximized-notice");
  const hidden = await waitFor(
    () => notice.isVisible(),
    (v) => !v,
    { timeoutMs: 8_000 },
  );
  r.ok("Maximize: the notice hides on its own", hidden.ok);
  const exit = page.getByRole("button", { name: "Restore" });
  const strip = page.locator("[data-demo-restore]");
  const box = await strip.boundingBox();
  r.ok(
    "Maximize: the exit strip sits at the top edge",
    box !== null && box.y < 4,
    JSON.stringify(box),
  );
  if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + 2);
  await exit.waitFor({ state: "visible", timeout: RENDER_TIMEOUT_MS });
  await snap(page, OUT, "4-full-screen");
  await exit.click();
  await urlSettles(r, page, "Restore: the URL loses ;full=1", (p) => p === at);
  r.ok("Restore: framed again", await framed(page));
  r.ok("Restore: still the same embed", await sameEmbed(page));
  r.eq("Restore: run as a view transition", await viewTransitions(page), 2);
  await showsPage(r, page, "the page is still open", TITLE);

  // ── 5. Back / Forward maximized, and out of it ──────────────────────
  await page.getByRole("button", { name: "Maximize" }).first().click();
  await urlSettles(r, page, "Maximize again", (p) => p === `${at};full=1`);
  // Another page of the sidebar: a move inside Pages.
  await embedRoot(page).getByText("Journal", { exact: true }).first().click();
  await showsPage(r, page, "maximized, the sidebar opens Journal", "Journal");
  await urlSettles(
    r,
    page,
    "maximized, the URL follows to Journal",
    (p) =>
      p.startsWith("/demo/at/pages/") &&
      p.endsWith(";full=1") &&
      p !== `${at};full=1`,
  );
  await page.goBack();
  await urlSettles(
    r,
    page,
    "Back: the URL returns to the page, maximized",
    (p) => p === `${at};full=1`,
  );
  await showsPage(r, page, "Back: the demo reopens the page", TITLE);
  r.ok("Back: still maximized", !(await framed(page)));
  await page.goBack();
  await urlSettles(r, page, "Back again: out of maximized", (p) => p === at);
  r.ok("Back again: framed", await framed(page));
  await page.goForward();
  await urlSettles(
    r,
    page,
    "Forward: maximized again",
    (p) => p === `${at};full=1`,
  );
  await showsPage(r, page, "Forward: the page is still open", TITLE);
  r.ok("Back / Forward: still the same embed", await sameEmbed(page));
  await snap(page, OUT, "5-back-forward");
  // Esc: the field's while a field has it; the demo's Restore otherwise.
  const title = embedRoot(page)
    .locator('[data-pane-id="page-detail"]')
    .last()
    .locator('input[aria-label="Page title"]')
    .first();
  await title.focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  r.ok(
    "Esc in a text field is the field's: still maximized",
    pathOf(page).endsWith(";full=1"),
    pathOf(page),
  );
  await title.evaluate((el) => (el as HTMLElement).blur());
  await page.keyboard.press("Escape");
  await urlSettles(r, page, "Esc outside a field restores", (p) => p === at);
  r.ok("Esc: framed again", await framed(page));

  // ── 6. the desktop, maximized: Back / Forward move between windows ──
  gate.on = false;
  await page.goto(pathUrl("/demo/at/desktop;full=1"));
  // No other tab is in the demo: the gate shows — maximized, as the URL is.
  await page
    .locator(ENTER_DEMO)
    .first()
    .waitFor({ timeout: RENDER_TIMEOUT_MS });
  r.ok(
    "a maximized URL opened fresh shows its gate maximized (no caption bar)",
    (await page.getByText(CAPTION_TEXT).count()) === 0,
  );
  await snap(page, OUT, "6-maximized-gate");
  await enterDemo(page, { marker: "[data-app-embed]" });
  await waitForNetworkIdle(page);
  gate.on = true;
  const desk = embedRoot(page);
  const windows = () => shownWindowIds(desk);
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
