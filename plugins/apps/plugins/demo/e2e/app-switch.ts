/**
 * The demo behaves like the app: you move between the apps it serves inside
 * the embed, never through the page (research/2026-10-24-global-demo-pages-
 * and-in-embed-app-switching.md, §C and Verification).
 *
 * In `/demo` (the Agent Manager on made-up data, served by the browser
 * worker), it:
 *
 *  0. presses inside the embed, then mod+B twice: the Agent Manager's
 *     sidebar collapses, then expands — once the user is in the embed, its
 *     app's surface-scoped shortcuts answer as they do in a tab, not the
 *     host page's (mounting the embed alone does not move the keys into it);
 *  1. opens the launcher inside the embed and picks Pages: the embed switches
 *     to Pages (`data-app-embed`, its theme scope), whose sidebar lists the
 *     seeded pages ("Welcome to equin", "Piano practice", "Ideas");
 *  2. goes back to the Agent Manager through the launcher;
 *  3. opens the practice-timer task's detail, and its Origin chip: the Piano practice page
 *     opens beside it;
 *  4. Expand on that page ("Open in Pages"): the embed switches to Pages on
 *     the Piano practice page.
 *
 * And asserts, throughout, that the page itself never moved:
 *
 *  - the page stays on the demo (its URL follows the embed, never the app);
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
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
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

/** The seeded pages (`website/demos/workspace`'s `core/internal/pages.ts`). */
const ROOT_PAGES = ["Welcome to equin", "Piano practice", "Ideas"] as const;
const ORIGIN_PAGE = "Piano practice";
/** The seeded task launched from Piano practice's prompt block (`stories.ts`). */
const PRACTICE_TIMER_TASK = "Practice timer in Sonata";
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

/**
 * The title of the page a page-detail pane shows (its title field's value —
 * the header's breadcrumb also carries the page's icon), or null while none
 * is open.
 */
async function pageTitle(pane: Locator): Promise<string | null> {
  const field = pane.first().locator('input[aria-label="Page title"]').first();
  return (await field.count()) > 0 ? await field.inputValue() : null;
}

/** The launcher drawn by the embedded app's brand. */
function launcherMark(page: Page): Locator {
  return embedRoot(page).getByRole("button", { name: "All apps" }).first();
}

await withBrowser(async (h) => {
  const r = report("demo: switching apps inside the embed");
  const { page, captured } = await h.session();
  const socketTap = await tapSharedSocket(page);

  await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
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
    r.ok(
      `${step}: the page stays on the demo`,
      onDemoPage(page.url()),
      page.url(),
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

  // ── 0. the embedded app's own shortcut: mod+B toggles its sidebar ───────
  // The user moves into the embed with a press on its sidebar (no control
  // there), then leaves the conversation's prompt editor: a rich-text field
  // claims mod+B (bold) for itself, as it does on the desktop.
  const sidebar = embedRoot(page).locator("[data-side][data-state]").first();
  const sidebarState = (): Promise<string | null> =>
    sidebar.getAttribute("data-state");
  await sidebar.dispatchEvent("pointerdown");
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await renders(
    "the Agent Manager's sidebar starts expanded",
    sidebarState,
    (state) => state === "expanded",
  );
  await page.keyboard.press("ControlOrMeta+b");
  await renders(
    "mod+B collapses the embedded app's sidebar",
    sidebarState,
    (state) => state === "collapsed",
  );
  await page.keyboard.press("ControlOrMeta+b");
  await renders(
    "mod+B expands it again",
    sidebarState,
    (state) => state === "expanded",
  );

  // ── 1. launcher → Pages ─────────────────────────────────────────────────
  r.ok(
    "the launcher offers Pages",
    await pickFromLauncher(embedRoot(page), /^\s*Pages\s*$/),
  );
  await renders(
    "the embed switches to Pages",
    () => embeddedApp(page),
    (id) => id === "pages",
  );
  r.eq(
    "the embed wears Pages' theme scope",
    await embedRoot(page).getAttribute("data-theme-scope"),
    demoAppThemeScope("pages"),
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
  const picked = await pickFromLauncher(embedRoot(page), /Agent manager/i);
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

  // ── 3. the practice-timer task's Origin chip → Piano practice ─────────────────
  await embedRoot(page)
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .click();
  const tree = embedRoot(page).getByRole("treegrid");
  await tree.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const taskRow = tree
    .getByRole("row")
    .filter({ hasText: PRACTICE_TIMER_TASK })
    .first();
  await taskRow.waitFor({ timeout: RENDER_TIMEOUT_MS });
  await taskRow.getByRole("gridcell").first().click();
  const detail = embedRoot(page).locator('[data-pane-id="task-detail"]');
  await detail.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const origin = detail
    .getByRole("button", { name: new RegExp(`^\\s*${ORIGIN_PAGE}\\s*$`) })
    .first();
  await renders(
    "the task detail's Origin section shows Piano practice",
    () => origin.count(),
    (n) => n > 0,
  );
  await origin.click();
  const pagePane = embedRoot(page).locator('[data-pane-id="page-detail"]');
  await renders(
    "the Origin chip opens Piano practice",
    () => pageTitle(pagePane),
    (title) => title === ORIGIN_PAGE,
  );
  pathStays("Origin chip");
  await noLeaveToast("Origin chip");
  await snap(page, OUT, "3-origin");

  // ── 4. Expand → Pages, on Piano practice ──────────────────────────────────────
  // By its exact label: a role-name match also took the header's ⋯ (More
  // actions) here, so the click opened the overflow instead.
  const openInPages = pagePane
    .first()
    .locator('button[aria-label="Open in Pages"]')
    .first();
  if ((await openInPages.count()) === 0) {
    r.fail("Piano practice offers Open in Pages", "no such button");
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
      "Pages opens on Piano practice",
      () => pageTitle(embedRoot(page).locator('[data-pane-id="page-detail"]')),
      (title) => title === ORIGIN_PAGE,
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
