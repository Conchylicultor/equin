/**
 * The Desktop runs in the demo, inside the embed
 * (research/2026-11-04-global-desktop-mode-in-browser-demo.md, Verification).
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Desktop: the embed's own
 *     tab set switches to the desktop — the Agent Manager it showed becomes a
 *     window, and the shelf appears — while the page around it stays as it
 *     was (no window outside the embed, the page URL still `/demo`);
 *  2. opens Pages from the shelf: a second window, beside the Agent Manager's,
 *     showing the demo's workspace ("Lumen");
 *  3. checks the page's own state is untouched: its sessionStorage tab set
 *     and window layout are byte-identical to before (the embed's desktop
 *     keeps its layout in memory, never in the page's storage).
 *
 * And asserts, throughout, that nothing left the scope — the list `no-leak.ts`
 * checks against (D3): no `/api/…` request for the page's origin but the
 * sanctioned telemetry routes, no page socket, no page or console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/desktop-in-demo.ts [--out /tmp/demo-desktop] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/demo-desktop";

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

/** How long an app swap, a mode switch or a worker read gets. */
const RENDER_TIMEOUT_MS = 30_000;

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/** The desktop's dock: the row holding the shelf's launcher button. */
function dock(page: Page): Locator {
  return embedRoot(page)
    .locator('button[title^="Apps ("]')
    .first()
    .locator("xpath=..");
}

/** The distinct windows (one titlebar tab strip each) inside `root`. */
async function windowIds(root: Locator): Promise<string[]> {
  const ids = await root
    .locator("[data-floating-window-id]")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-floating-window-id") ?? ""),
    );
  return [...new Set(ids)].sort();
}

/**
 * The page's own persisted tab set and window layout (sessionStorage): each
 * entry's tabs and focus (a tab set's `mode` may resolve from its unregistered
 * `""` to the default on a later write, and every write restamps `ts`), and
 * whether any window layout was stored at all.
 */
async function pageShellStorage(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const tabSets: Record<string, unknown> = {};
    const windowKeys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      if (key.includes("desktop.windows")) windowKeys.push(key);
      if (!key.includes("apps-core.tabs")) continue;
      const entry = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
        v?: { tabs?: unknown; focusedTabId?: unknown; mode?: unknown };
      } | null;
      tabSets[key] = {
        tabs: entry?.v?.tabs,
        focusedTabId: entry?.v?.focusedTabId,
        desktop: entry?.v?.mode === "floating",
      };
    }
    return { tabSets, windowKeys };
  });
}

await withBrowser(async (h) => {
  const r = report("demo: the Desktop inside the embed");
  const { page, captured } = await h.session();

  await boot(page, pathUrl("/demo"), {
    marker: 'button:has-text("Conversations")',
  });

  const leaked: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.origin !== new URL(page.url()).origin) return;
    if (!url.pathname.startsWith("/api/")) return;
    if (!SANCTIONED.some((re) => re.test(url.pathname)))
      leaked.push(`${req.method()} ${url.pathname}`);
  };
  page.on("request", onRequest);
  const openedSockets: string[] = [];
  const onSocket = (ws: WebSocket): void => {
    openedSockets.push(new URL(ws.url()).pathname);
  };
  page.on("websocket", onSocket);

  const renders = async <T>(
    name: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<Settled<T>> => {
    const settled = await waitFor(read, ok, { timeoutMs: RENDER_TIMEOUT_MS });
    r.ok(
      name,
      settled.ok,
      `${JSON.stringify(settled.value)} (waited ${settled.waitedMs} ms)`,
    );
    return settled;
  };

  // Settle the page's own storage writes from boot before taking the baseline.
  await page.waitForTimeout(1_000);
  const storageBefore = await pageShellStorage(page);

  // ── 1. launcher → Desktop ───────────────────────────────────────────────
  await embedRoot(page)
    .getByRole("button", { name: "All apps" })
    .first()
    .hover();
  const menu = page.locator('[aria-label="Apps"]').last();
  await menu.waitFor({ timeout: 5_000 });
  const tile = menu
    .locator('[data-row-key][role="button"]')
    .filter({ hasText: /^\s*Desktop\s*$/ })
    .first();
  await renders(
    "the launcher offers Desktop",
    () => tile.count(),
    (n) => n > 0,
  );
  await tile.click();
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  const firstWindow = await renders(
    "the embed is a desktop: the Agent Manager is its one window",
    () => windowIds(embedRoot(page)),
    (ids) => ids.length === 1,
  );
  await renders(
    "the shelf shows inside the embed, with Pages pinned",
    () => dock(page).getByRole("button", { name: "Pages" }).count(),
    (n) => n > 0,
  );
  r.eq(
    "no window outside the embed (the page is not in desktop mode)",
    await page.locator("[data-floating-window-id]").count(),
    await embedRoot(page).locator("[data-floating-window-id]").count(),
  );
  r.eq("the page URL stays /demo", new URL(page.url()).pathname, "/demo");
  await snap(page, OUT, "1-desktop");

  // ── 2. Pages from the shelf: a second window ────────────────────────────
  await dock(page).getByRole("button", { name: "Pages" }).first().click();
  const both = await renders(
    "Pages opens as a second window",
    () => windowIds(embedRoot(page)),
    (ids) => ids.length === 2,
  );
  r.ok(
    "the Agent Manager's window is still there",
    firstWindow.value.every((id) => both.value.includes(id)),
    JSON.stringify(both.value),
  );
  await renders(
    "the Pages window shows the demo's workspace",
    () => embedRoot(page).getByText("Lumen", { exact: true }).count(),
    (n) => n > 0,
  );
  r.eq("the page URL stays /demo", new URL(page.url()).pathname, "/demo");
  await snap(page, OUT, "2-two-windows");

  // ── 3. the page's own state ─────────────────────────────────────────────
  await page.waitForTimeout(1_000);
  r.eq(
    "the page's persisted tab set and window layout are unchanged",
    await pageShellStorage(page),
    storageBefore,
  );

  page.off("request", onRequest);
  page.off("websocket", onSocket);

  r.eq(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked,
    [],
  );
  r.eq("the page opened no socket of its own", openedSockets, []);
  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
