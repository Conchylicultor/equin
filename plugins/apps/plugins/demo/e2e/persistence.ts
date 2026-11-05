/**
 * The demo keeps the visitor's data in the browser (design: the wiki page
 * "Design: a browser host's data kept in browser storage"). In `/demo`, in
 * one fresh browser context (so its IndexedDB starts empty), it:
 *
 *  1. opens Pages in the embed, creates a page ("New page") and names it;
 *  2. reloads the tab: the page is still there, and the seed did not run
 *     again (each seeded root page is listed once);
 *  3. opens a SECOND tab of the demo in the same context: it shows the page
 *     too (one SharedWorker, one database) — then creates another page there,
 *     which the first tab's sidebar shows live;
 *  4. Reset demo (in the first tab): both tabs come back on the seed alone —
 *     neither created page is listed, the seeded pages are.
 *
 * And, throughout: the page URL stays `/demo`, no page error, no console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/persistence.ts [--out /tmp/demo-persistence] [--headed]
 */
import type { Locator, Page } from "playwright";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/demo-persistence";

/** The seeded root pages (`website/demos/lumen`'s `core/internal/pages.ts`). */
const ROOT_PAGES = ["Lumen", "Ideas"] as const;
/** How long an app swap, a worker read or a host boot gets to render. */
const RENDER_TIMEOUT_MS = 30_000;
const MARKER = 'button:has-text("Conversations")';

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/** The Pages sidebar entries titled exactly `title`. */
function sidebarEntries(page: Page, title: string): Locator {
  return embedRoot(page)
    .locator("[data-row-key]")
    .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) });
}

/** Switch the embed to Pages through its launcher. */
async function openPages(r: Report, page: Page, step: string): Promise<void> {
  r.ok(
    `${step}: the launcher offers Pages`,
    await pickFromLauncher(embedRoot(page), /^\s*Pages\s*$/),
  );
  const settled = await waitFor(
    () => embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === "pages",
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(`${step}: the embed shows Pages`, settled.ok, String(settled.value));
}

/** Create a root page through the sidebar's "New page" and title it `title`. */
async function createPage(page: Page, title: string): Promise<void> {
  await embedRoot(page).getByText("New page", { exact: true }).first().click();
  const detail = embedRoot(page).locator('[data-pane-id="page-detail"]').last();
  await detail.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const titleField = detail.locator('input[aria-label="Page title"]').first();
  await titleField.fill(title);
  await titleField.press("Enter");
}

/**
 * Wait until the sidebar lists `title` as `want` says — exactly n times, or
 * `"some"`: at least once (the sidebar shows a page in several sections).
 * Returns how many times it did.
 */
async function listed(
  r: Report,
  page: Page,
  name: string,
  title: string,
  want: number | "some",
): Promise<number> {
  const settled = await waitFor(
    () => sidebarEntries(page, title).count(),
    (count) => (want === "some" ? count > 0 : count === want),
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(
    name,
    settled.ok,
    `"${title}" listed ${settled.value}× (want ${want}; waited ${settled.waitedMs} ms)`,
  );
  return settled.value;
}

/** Wait until the embed shows `app` — after a Reset, the remounted demo opens on its own app again. */
async function showsApp(
  r: Report,
  page: Page,
  name: string,
  app: string,
): Promise<void> {
  const settled = await waitFor(
    // While the host reboots there is no embed at all.
    async () =>
      (await embedRoot(page).count()) === 0
        ? null
        : embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === app,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(name, settled.ok, String(settled.value));
}

await withBrowser(async (h) => {
  const r = report("demo: the visitor's data is kept in the browser");
  const { page, context } = await h.session();
  const stamp = Date.now().toString(36);
  const FIRST = `Kept ${stamp}`;
  const SECOND = `Shared ${stamp}`;

  // ── 1. a write ──────────────────────────────────────────────────────────
  await boot(page, pathUrl("/demo"), { marker: MARKER });
  await openPages(r, page, "first boot");
  const seeded = new Map<string, number>();
  for (const title of ROOT_PAGES) {
    seeded.set(
      title,
      await listed(r, page, `the seed lists "${title}"`, title, "some"),
    );
  }
  await createPage(page, FIRST);
  await listed(r, page, "the created page is listed", FIRST, "some");
  await snap(page, OUT, "1-created");

  // ── 2. it survives a reload; the seed does not run again ────────────────
  await page.reload();
  await page.locator(MARKER).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await openPages(r, page, "after a reload");
  await listed(
    r,
    page,
    "after a reload, the created page is still listed",
    FIRST,
    "some",
  );
  for (const title of ROOT_PAGES) {
    await listed(
      r,
      page,
      `after a reload, "${title}" is listed as often as on the first boot (no second seed)`,
      title,
      seeded.get(title)!,
    );
  }
  await snap(page, OUT, "2-reloaded");

  // ── 3. a second tab shares the data, live ───────────────────────────────
  const second = await context.newPage();
  await second.goto(pathUrl("/demo"));
  await second.locator(MARKER).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await openPages(r, second, "second tab");
  await listed(
    r,
    second,
    "the second tab lists the first tab's page",
    FIRST,
    "some",
  );
  await createPage(second, SECOND);
  await listed(r, second, "the second tab lists its own page", SECOND, "some");
  await listed(
    r,
    page,
    "the first tab lists the second tab's page, live",
    SECOND,
    "some",
  );
  await snap(second, OUT, "3-second-tab");

  // ── 4. Reset demo brings the seed back, in both tabs ────────────────────
  await page.getByRole("button", { name: "Reset demo" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reset demo" })
    .click();
  for (const [tab, label] of [
    [page, "first tab"],
    [second, "second tab"],
  ] as const) {
    // Both tabs were on Pages: a remounted demo opens on the Agent Manager.
    await snap(tab, OUT, `4-resetting-${label.replace(" ", "-")}`);
    await showsApp(
      r,
      tab,
      `after Reset, the ${label} boots the demo again`,
      "agent-manager",
    );
    await tab.locator(MARKER).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await openPages(r, tab, `after Reset (${label})`);
    // The seeded pages first: once they are listed, the sidebar has loaded.
    for (const title of ROOT_PAGES) {
      await listed(
        r,
        tab,
        `after Reset, the ${label} lists the seeded "${title}" as the first boot did`,
        title,
        seeded.get(title)!,
      );
    }
    await listed(
      r,
      tab,
      `after Reset, the ${label} no longer lists "${FIRST}"`,
      FIRST,
      0,
    );
    await listed(
      r,
      tab,
      `after Reset, the ${label} no longer lists "${SECOND}"`,
      SECOND,
      0,
    );
  }
  await snap(page, OUT, "4-reset");

  r.eq("the page URL stays /demo", new URL(page.url()).pathname, "/demo");
  await r.finish();
});
