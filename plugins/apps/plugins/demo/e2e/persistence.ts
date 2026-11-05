/**
 * The demo keeps the visitor's data in the browser (design: the wiki page
 * "Design: a browser host's data kept in browser storage"). In `/demo`, in
 * one fresh browser context (so its IndexedDB starts empty), it:
 *
 *  1. opens Pages in the embed: a seeded page wears the seed's icon; creates
 *     a page ("New page"), names it, and picks an icon for it in the emoji
 *     picker (its data loaded through the demo's worker);
 *  2. reloads the tab: the page is still there with its icon, and the seed
 *     did not run again (each seeded root page is listed once);
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
/** A seeded page and the icon the seed gave it. */
const SEEDED_ICON = { title: "Ideas", emoji: "💭" } as const;
/** The emoji the visitor picks for the page it created, and its search word. */
const PICKED = { search: "rocket", emoji: "🚀" } as const;
/** How long an app swap, a worker read or a host boot gets to render. */
const RENDER_TIMEOUT_MS = 30_000;
const MARKER = 'button:has-text("Conversations")';

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/**
 * The Pages sidebar entries titled exactly `title` — after the page's icon,
 * an emoji glyph that is part of the row's text (hidden from assistive tech
 * only).
 */
function sidebarEntries(page: Page, title: string): Locator {
  return embedRoot(page)
    .locator("[data-row-key]")
    .filter({
      hasText: new RegExp(
        `^\\s*(?:\\p{Extended_Pictographic}[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\uFE0F\\u200D]*\\s*)?${title}\\s*$`,
        "u",
      ),
    });
}

/** The open page's header icon (the large glyph that opens the picker). */
function headerIcon(page: Page): Locator {
  return embedRoot(page)
    .locator('[data-pane-id="page-detail"]')
    .last()
    .getByRole("button", { name: "Change page icon" });
}

/** Open the page titled `title` from the sidebar. */
async function openPage(page: Page, title: string): Promise<void> {
  await sidebarEntries(page, title).first().click();
  await embedRoot(page)
    .locator('[data-pane-id="page-detail"]')
    .last()
    .locator('input[aria-label="Page title"]')
    .first()
    .waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Wait until the open page's header icon shows `emoji`. */
async function showsIcon(
  r: Report,
  page: Page,
  name: string,
  emoji: string,
): Promise<void> {
  const settled = await waitFor(
    async () =>
      (await headerIcon(page).count()) === 0
        ? null
        : headerIcon(page).first().textContent(),
    (text) => text?.trim() === emoji,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(name, settled.ok, `header icon: ${JSON.stringify(settled.value)}`);
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

  // The header's tools show on hover; "Add icon" opens the emoji picker.
  const detail = embedRoot(page).locator('[data-pane-id="page-detail"]').last();
  await detail.locator('input[aria-label="Page title"]').first().hover();
  await detail.getByRole("button", { name: "Add icon" }).first().click();
  const search = page.getByPlaceholder("Search emoji…");
  await search.waitFor({ timeout: RENDER_TIMEOUT_MS });
  await search.fill(PICKED.search);
  // The grid finds the emoji: its data loaded, through the demo's worker.
  // Exactly the emoji: a ZWJ sequence holding it (🧑‍🚀) is another one.
  const cell = page
    .locator("button")
    .filter({ hasText: new RegExp(`^\\s*${PICKED.emoji}\\s*$`, "u") })
    .first();
  const found = await waitFor(
    () => cell.count(),
    (n) => n > 0,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok(
    `the emoji picker loads in the demo and finds "${PICKED.search}"`,
    found.ok,
    `waited ${found.waitedMs} ms`,
  );
  await snap(page, OUT, "1-picker");
  await cell.click();
  await showsIcon(r, page, "the picked icon is the page's", PICKED.emoji);
  await openPage(page, SEEDED_ICON.title);
  await showsIcon(
    r,
    page,
    `the seeded "${SEEDED_ICON.title}" wears its icon`,
    SEEDED_ICON.emoji,
  );

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
  await openPage(page, FIRST);
  await showsIcon(
    r,
    page,
    "after a reload, the created page keeps its picked icon",
    PICKED.emoji,
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
