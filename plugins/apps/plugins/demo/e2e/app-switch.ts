/**
 * The demo behaves like the app: you move between the apps it serves inside
 * the embed, never through the page (research/2026-10-24-global-demo-pages-
 * and-in-embed-app-switching.md, §C and Verification).
 *
 * In `/demo` (the Agent Manager on made-up data, served by the browser
 * worker), it:
 *
 *  1. opens the launcher inside the embed and picks Pages: the embed switches
 *     to Pages (`data-app-embed`, its theme scope), whose sidebar lists the
 *     seeded pages ("Lumen", "Ideas");
 *  2. goes back to the Agent Manager through the launcher;
 *  3. opens the dark-mode task's detail, and its Origin chip: the Bugs page
 *     opens beside it;
 *  4. Expand on that page ("Open in Pages"): the embed switches to Pages on
 *     the Bugs page.
 *
 * And asserts, throughout, that the page itself never moved:
 *
 *  - the page URL's path stays `/demo` (the embed's stores are non-live);
 *  - no request for `/api/…` left for the page's origin during the steps,
 *    except the sanctioned telemetry routes — the list `no-leak.ts` checks
 *    against (D3) — and no page socket was opened, and the page's own
 *    live-state socket subscribed to nothing naming the demo's data;
 *  - no "Opens outside this embed" toast, no page error, no console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/app-switch.ts [--out /tmp/demo-app-switch] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
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

const OUT = arg("out") ?? "/tmp/demo-app-switch";

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

/** The seeded pages (`agent-manager/demo`'s `core/internal/pages.ts`). */
const ROOT_PAGES = ["Lumen", "Ideas"] as const;
const BUGS_PAGE = "Bugs";
/** The seeded task launched from the Bugs page's prompt block (`stories.ts`). */
const DARK_MODE_TASK = "Dark mode resets after a reload";
/** How long an app swap or a worker read gets to render. */
const RENDER_TIMEOUT_MS = 20_000;
const LEAVE_TOAST = "Opens outside this embed";

/** The embed's root: `AppEmbed` names the app it shows on it. */
function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

async function embeddedApp(page: Page): Promise<string | null> {
  return embedRoot(page).getAttribute("data-app-embed");
}

/** The launcher drawn by the embedded app's brand. */
function launcherMark(page: Page): Locator {
  return embedRoot(page).getByRole("button", { name: "All apps" }).first();
}

/**
 * Hover the embed's launcher and pick the tile named `name`; `false` when the
 * grid has no such tile (the composition's home app is the mark itself).
 */
async function pickFromLauncher(page: Page, name: RegExp): Promise<boolean> {
  await launcherMark(page).hover();
  const menu = page.locator('[aria-label="Apps"]').last();
  await menu.waitFor({ timeout: 5_000 });
  const tile = menu
    .locator('[data-row-key][role="button"]')
    .filter({ hasText: name })
    .first();
  if ((await tile.count()) === 0) {
    await page.keyboard.press("Escape");
    return false;
  }
  await tile.click();
  return true;
}

await withBrowser(async (h) => {
  const r = report("demo: switching apps inside the embed");
  const { page, captured } = await h.session();
  const socketTap = await tapSharedSocket(page);

  await boot(page, pathUrl("/demo"), {
    marker: 'button:has-text("Conversations")',
  });
  await page
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .waitFor();

  // From here on, every /api request the page itself sends is recorded.
  const leaked: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
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
  const NOTIFICATIONS = "/ws/notifications";
  const sentBefore = socketTap.sent(NOTIFICATIONS).length;

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
  const pathStays = (step: string): void => {
    r.eq(
      `${step}: the page URL stays /demo`,
      new URL(page.url()).pathname,
      "/demo",
    );
  };
  const noLeaveToast = async (step: string): Promise<void> => {
    r.eq(
      `${step}: no "${LEAVE_TOAST}" toast`,
      await page.getByText(LEAVE_TOAST).count(),
      0,
    );
  };

  r.eq(
    "the embed opens on the Agent Manager",
    await embeddedApp(page),
    "agent-manager",
  );

  // ── 1. launcher → Pages ─────────────────────────────────────────────────
  r.ok(
    "the launcher offers Pages",
    await pickFromLauncher(page, /^\s*Pages\s*$/),
  );
  await renders(
    "the embed switches to Pages",
    () => embeddedApp(page),
    (id) => id === "pages",
  );
  r.eq(
    "the embed wears Pages' theme scope",
    await embedRoot(page).getAttribute("data-theme-scope"),
    "app:pages",
  );
  for (const title of ROOT_PAGES) {
    await renders(
      `the Pages sidebar lists the seeded page "${title}"`,
      () => embedRoot(page).getByText(title, { exact: true }).count(),
      (n) => n > 0,
    );
  }
  pathStays("Pages");
  await noLeaveToast("Pages");
  await snap(page, OUT, "1-pages");

  // ── 2. launcher → back to the Agent Manager ─────────────────────────────
  // The composition's home app is the launcher mark itself (not a tile).
  const picked = await pickFromLauncher(page, /Agent manager/i);
  if (!picked) await launcherMark(page).click();
  // The pointer still rests on the mark, so its hover grid stays open over the
  // sidebar: dismiss it and move off, as a user would.
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  r.note(
    `back via ${picked ? "the Agent Manager tile" : "the launcher mark (home)"}`,
  );
  await renders(
    "the embed switches back to the Agent Manager",
    () => embeddedApp(page),
    (id) => id === "agent-manager",
  );
  pathStays("back to the Agent Manager");
  await noLeaveToast("back to the Agent Manager");

  // ── 3. the dark-mode task's Origin chip → the Bugs page ─────────────────
  await embedRoot(page)
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .click();
  const tree = embedRoot(page).getByRole("treegrid");
  await tree.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const taskRow = tree
    .getByRole("row")
    .filter({ hasText: DARK_MODE_TASK })
    .first();
  await taskRow.waitFor({ timeout: RENDER_TIMEOUT_MS });
  await taskRow.getByRole("gridcell").first().click();
  const detail = embedRoot(page).locator('[data-pane-id="task-detail"]');
  await detail.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const origin = detail
    .getByRole("button", { name: new RegExp(`^\\s*${BUGS_PAGE}\\s*$`) })
    .first();
  await renders(
    "the task detail's Origin section shows the Bugs page",
    () => origin.count(),
    (n) => n > 0,
  );
  await origin.click();
  const pagePane = embedRoot(page).locator('[data-pane-id="page-detail"]');
  await renders(
    "the Origin chip opens the Bugs page",
    async () =>
      (await pagePane.count()) > 0
        ? pagePane.first().getByText(BUGS_PAGE, { exact: true }).count()
        : 0,
    (n) => n > 0,
  );
  pathStays("Origin chip");
  await noLeaveToast("Origin chip");
  await snap(page, OUT, "3-origin");

  // ── 4. Expand → Pages, on the Bugs page ─────────────────────────────────
  // By its exact label: a role-name match also took the header's ⋯ (More
  // actions) here, so the click opened the overflow instead.
  const openInPages = pagePane
    .first()
    .locator('button[aria-label="Open in Pages"]')
    .first();
  if ((await openInPages.count()) === 0) {
    r.fail("the Bugs page offers Open in Pages", "no such button");
  } else {
    // The header is an overflow bar that re-lays out as the pointer moves over
    // it, so a locator click can land on whatever slid under its aim (the ⋯).
    // Aim at where the button settled, as a user's eye does.
    await page.keyboard.press("Escape");
    await openInPages.hover();
    await page.waitForTimeout(500);
    const box = await openInPages.boundingBox();
    if (box === null) throw new Error("Open in Pages has no box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await renders(
      "Open in Pages switches the embed to Pages",
      () => embeddedApp(page),
      (id) => id === "pages",
    );
    await renders(
      "Pages opens on the Bugs page",
      async () => {
        const pane = embedRoot(page).locator('[data-pane-id="page-detail"]');
        return (await pane.count()) > 0
          ? pane.first().getByText(BUGS_PAGE, { exact: true }).count()
          : 0;
      },
      (n) => n > 0,
    );
    pathStays("Open in Pages");
    await noLeaveToast("Open in Pages");
    await snap(page, OUT, "4-open-in-pages");
  }

  page.off("request", onRequest);
  page.off("websocket", onSocket);

  // ── assertions ──────────────────────────────────────────────────────────
  r.eq(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked,
    [],
  );
  r.eq("the page opened no socket of its own", openedSockets, []);
  const pageSubs = socketTap
    .sent(NOTIFICATIONS)
    .slice(sentBefore)
    .filter((f) => f.op === "sub" || f.op === "sub-batch");
  r.eq(
    "the page's live-state socket subscribed to no demo data",
    pageSubs
      .filter((f) => JSON.stringify(f).includes("demo"))
      .map((f) => JSON.stringify(f)),
    [],
  );
  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
