/**
 * Verifies the search query's storage scope after it moved off the device-local
 * `${storageKey}:view-state` blob onto per-browser-tab
 * `${storageKey}:view-query`.
 *
 * Four claims:
 *   1. typing writes `${storageKey}:view-query` in sessionStorage, keyed by the
 *      active view instance;
 *   2. NOTHING lands in the localStorage `view-state` blob (the durable half
 *      stays expand/collapse only);
 *   3. a reload keeps the query — that is the one property worth persisting;
 *   4. a fresh browser context starts clean, so a query cannot outlive the
 *      session that typed it and silently present a subset as the whole list.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/primitives/plugins/data-view/e2e/search-query-scope.ts [--headed]
 */
import type { Page } from "playwright";
import {
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/** The tasks list — a DataView whose `recent` instance is a plain flat list. */
const SURFACE = "tasks-list";
const VIEW_ID = "recent";
const QUERY = "audit";

async function sessionQuery(page: Page): Promise<string | undefined> {
  return page.evaluate((surface) => {
    const raw = sessionStorage.getItem(`${surface}:view-query`);
    if (!raw) return undefined;
    return (JSON.parse(raw) as Record<string, string>).recent;
  }, SURFACE);
}

/** Every key the durable blob holds for this view instance. */
async function localKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ surface, viewId }) => {
      const raw = localStorage.getItem(`${surface}:view-state`);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      return Object.keys(parsed[viewId] ?? {});
    },
    { surface: SURFACE, viewId: VIEW_ID },
  );
}

/**
 * The title of the topmost rendered row that does NOT match `QUERY` — the
 * witness for "the query actually filters". Read off the virtualized rows, which
 * exist because the unfiltered list is far past the windowing threshold.
 */
async function firstNonMatchingTitle(page: Page): Promise<string | null> {
  return page.evaluate((query) => {
    const rows = [...document.querySelectorAll("[data-index]")].sort(
      (a, b) =>
        Number(a.getAttribute("data-index")) -
        Number(b.getAttribute("data-index")),
    );
    for (const row of rows) {
      const title = row.querySelector("span, div")?.textContent?.trim();
      if (title && !title.toLowerCase().includes(query)) return title;
    }
    return null;
  }, QUERY);
}

const r = report("data-view search-query scope");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("/agents/tasks"), { settleMs: 1500 });
  await page
    .getByRole("button", { name: "Recent", exact: true })
    .first()
    .click();
  await page.waitForTimeout(1500);

  const witness = await firstNonMatchingTitle(page);
  if (witness === null)
    throw new Error("no non-matching row to use as witness");

  const search = page.getByRole("textbox").first();
  await search.fill(QUERY);
  await page.waitForTimeout(1000);

  // 1. The query is in sessionStorage under the active instance's id.
  r.ok(
    `"${QUERY}" recorded in ${SURFACE}:view-query (sessionStorage)`,
    (await sessionQuery(page)) === QUERY,
  );

  // 2. …and nowhere in the durable blob.
  const keys = await localKeys(page);
  r.ok(
    "view-state holds no `query` key",
    !keys.includes("query"),
    JSON.stringify(keys),
  );

  // It actually filters, so claims 3/4 are testing a visible effect.
  const witnessGone = !(await page
    .getByText(witness, { exact: true })
    .first()
    .isVisible());
  r.ok("the query narrows the list", witnessGone, `witness: "${witness}"`);

  // 3. A reload keeps it — an F5 must not lose your place.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  r.ok("the query survives a reload", (await sessionQuery(page)) === QUERY);

  // 4. A fresh context (a new tab / a browser restart) starts clean.
  const { page: fresh } = await h.session({ label: "fresh" });
  await boot(fresh, pathUrl("/agents/tasks"), { settleMs: 1500 });
  r.ok(
    "a fresh browser session starts with no query",
    (await sessionQuery(fresh)) === undefined,
  );
});

await r.finish();
