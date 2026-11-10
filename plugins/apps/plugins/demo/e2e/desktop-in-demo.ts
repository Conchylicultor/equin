/**
 * The Desktop runs in the demo, inside the embed
 * (research/2026-11-04-global-desktop-mode-in-browser-demo.md, Verification).
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Desktop: the embed's own
 *     tab set switches to the desktop — the Agent Manager it showed becomes a
 *     window, and the shelf appears — while the page around it stays as it
 *     was (no window outside the embed, the page still the demo);
 *  2. opens Pages from the shelf: a second window, beside the Agent Manager's,
 *     showing the demo's workspace ("Welcome to equin");
 *  3. takes a window full screen from its titlebar's Full screen
 *     control (as on the real desktop): the windows give way to that one tab,
 *     filling the embed box — the embed is its tab set's viewport — and the
 *     page stays as it was; the Layout control brings the desktop back, both
 *     windows intact;
 *  3b. right-clicks the empty desktop and changes the wallpaper through
 *     "Change wallpaper…" — an imperative dialog, rendered in the embed's own
 *     render origin, so the picker reads and writes the scope's config (the
 *     pick reads back as selected when the picker reopens);
 *  4. checks the page's own state is untouched: its sessionStorage tab set
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
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import { shownWindowIds } from "@plugins/apps/plugins/desktop/plugins/windows/e2e";
import { pickSurfaceMode } from "@plugins/apps-core/plugins/surface/e2e";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  demoAppThemeScope,
  AGENT_MANAGER_LOCATION,
  demoPath,
  onDemoPage,
  bootDemo,
} from "./internal/demo-pages";

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

/**
 * The page's own persisted tab set and window layout (sessionStorage): each
 * entry's tabs (their ids and apps — the demo tab's route carries the demo's
 * location, which moves with the embed by design) and focus (a tab set's
 * `mode` may resolve from its unregistered `""` to the default on a later
 * write, and every write restamps `ts`), and whether any window layout was
 * stored at all.
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
        v?: {
          tabs?: { tabId: string; appId: string }[];
          focusedTabId?: unknown;
          mode?: unknown;
        };
      } | null;
      tabSets[key] = {
        tabs: entry?.v?.tabs?.map(({ tabId, appId }) => ({ tabId, appId })),
        focusedTabId: entry?.v?.focusedTabId,
        desktop: entry?.v?.mode === "floating",
      };
    }
    return { tabSets, windowKeys };
  });
}

/**
 * Right-click the empty desktop inside the embed (a point no window covers,
 * where the backdrop's capture layer is on top) and pick "Change wallpaper…";
 * returns the wallpaper dialog.
 */
async function openWallpaperPicker(page: Page): Promise<Locator> {
  const point = await embedRoot(page).evaluate((embed) => {
    const box = embed.getBoundingClientRect();
    for (let y = box.top + 40; y < box.bottom - 80; y += 24)
      for (let x = box.left + 24; x < box.right - 24; x += 24) {
        const el = document.elementFromPoint(x, y);
        if (
          el instanceof HTMLElement &&
          embed.contains(el) &&
          el.getAttribute("aria-hidden") === "true" &&
          el.classList.contains("inset-0")
        )
          return { x, y };
      }
    return null;
  });
  if (point === null) throw new Error("no empty desktop to right-click");
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page
    .getByRole("menuitem", { name: /Change wallpaper/ })
    .first()
    .click();
  const dialog = page
    .getByRole("dialog")
    .filter({ hasText: "Change wallpaper" })
    .first();
  await dialog.waitFor({ timeout: RENDER_TIMEOUT_MS });
  return dialog;
}

/**
 * Change the wallpaper to a built-in one not in use; returns its title (the
 * tile's image alt), or null when the dialog did not close on the pick.
 */
async function changeWallpaper(page: Page): Promise<string | null> {
  const dialog = await openWallpaperPicker(page);
  const tile = dialog.locator('button[aria-pressed="false"]:has(img)').first();
  const title = await tile.locator("img").getAttribute("alt");
  await tile.click();
  const closed = await dialog
    .waitFor({ state: "detached", timeout: RENDER_TIMEOUT_MS })
    .then(() => true)
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") return false;
      throw err;
    });
  return closed ? title : null;
}

await withBrowser(async (h) => {
  const r = report("demo: the Desktop inside the embed");
  const { page, captured } = await h.session();

  await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
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
  r.ok(
    "the launcher offers Desktop",
    await pickFromLauncher(embedRoot(page), /^\s*Desktop\s*$/),
  );
  const firstWindow = await renders(
    "the embed is a desktop: the Agent Manager is its one window",
    () => shownWindowIds(embedRoot(page)),
    (ids) => ids.length === 1,
  );
  await renders(
    "the shelf shows inside the embed, with Pages pinned",
    () => dock(page).getByRole("button", { name: "Pages" }).count(),
    (n) => n > 0,
  );
  for (const name of ["Files", "Places", "Prototypes"]) {
    await renders(
      `the dock also keeps ${name} pinned`,
      () => dock(page).getByRole("button", { name }).count(),
      (n) => n > 0,
    );
  }
  r.eq(
    "no window outside the embed (the page is not in desktop mode)",
    await page.locator("[data-floating-window-id]").count(),
    await embedRoot(page).locator("[data-floating-window-id]").count(),
  );
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  await snap(page, OUT, "1-desktop");

  // ── 2. Pages from the shelf: a second window ────────────────────────────
  await dock(page).getByRole("button", { name: "Pages" }).first().click();
  const both = await renders(
    "Pages opens as a second window",
    () => shownWindowIds(embedRoot(page)),
    (ids) => ids.length === 2,
  );
  r.ok(
    "the Agent Manager's window is still there",
    firstWindow.value.every((id) => both.value.includes(id)),
    JSON.stringify(both.value),
  );
  await renders(
    "the Pages window shows the demo's workspace",
    () =>
      embedRoot(page).getByText("Welcome to equin", { exact: true }).count(),
    (n) => n > 0,
  );
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  await snap(page, OUT, "2-two-windows");

  // ── 3. Full screen from a window's titlebar, the Layout control back ──────
  const fullScreen = embedRoot(page).getByRole("button", {
    name: "Full screen",
  });
  await renders(
    "every window's titlebar offers Full screen, as on the real desktop",
    () => fullScreen.count(),
    (n) => n === 2,
  );
  await fullScreen.last().click();
  await renders(
    "Full screen leaves no window: the surface shows the one tab",
    () => shownWindowIds(embedRoot(page)),
    (ids) => ids.length === 0,
  );
  const filled = await renders(
    "the full-screen tab fills the embed box, not the page",
    () =>
      embedRoot(page).evaluate((embed) => {
        const box = embed.getBoundingClientRect();
        // A hidden keep-alive tab is `content-visibility: hidden` (kept
        // styled, skipped), and every tab of a hidden mode is under its
        // `display: none` <Activity>: shown is neither.
        const shown = [
          ...embed.querySelectorAll<HTMLElement>("[data-tab-id]"),
        ].filter((el) => {
          const style = getComputedStyle(el);
          return el.checkVisibility() && style.contentVisibility !== "hidden";
        });
        if (shown.length !== 1) return null;
        const tab = shown[0]!.getBoundingClientRect();
        return {
          scope: shown[0]!.getAttribute("data-theme-scope"),
          dx: Math.round(Math.abs(tab.left - box.left)),
          dy: Math.round(Math.abs(tab.top - box.top)),
          dw: Math.round(Math.abs(tab.width - box.width)),
          dh: Math.round(Math.abs(tab.height - box.height)),
        };
      }),
    (d) => d !== null && d.dx <= 1 && d.dy <= 1 && d.dw <= 1 && d.dh <= 1,
  );
  r.eq(
    "the full-screen tab is the one the embed shows",
    filled.value?.scope,
    demoAppThemeScope(
      (await embedRoot(page).getAttribute("data-app-embed")) ?? "",
    ),
  );
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  await snap(page, OUT, "3-full-screen");
  await pickSurfaceMode(page, "Desktop");
  await renders(
    "the Layout control returns to the desktop with both windows",
    () => shownWindowIds(embedRoot(page)),
    (ids) => ids.length === 2 && both.value.every((id) => ids.includes(id)),
  );
  await snap(page, OUT, "3-back-to-desktop");

  // ── 3b. an imperative dialog raised inside the embed ────────────────────
  // The desktop's "Change wallpaper…" opens through the imperative dialog,
  // which renders in the caller's render origin: the picker reads the
  // scope's registry and config, and its pick writes the scope's config —
  // a dialog rendered by the page's chrome would write the page's.
  const pickedTitle = await changeWallpaper(page);
  r.ok(
    "Change wallpaper… opens the picker in the embed's scope, and a pick closes it",
    pickedTitle !== null,
    String(pickedTitle),
  );
  if (pickedTitle !== null) {
    const pressed = await openWallpaperPicker(page);
    const tile = pressed.getByRole("button", { name: pickedTitle });
    r.eq(
      "reopened, the picker shows the pick — written to the scope's config and read back",
      await tile.getAttribute("aria-pressed"),
      "true",
    );
    await page.keyboard.press("Escape");
    await pressed.waitFor({ state: "detached", timeout: RENDER_TIMEOUT_MS });
  }
  await snap(page, OUT, "3b-wallpaper");

  // ── 4. the page's own state ─────────────────────────────────────────────
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
