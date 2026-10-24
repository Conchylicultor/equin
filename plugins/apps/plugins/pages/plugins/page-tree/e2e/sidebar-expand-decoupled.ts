/**
 * Verifies that the Pages sidebar chevron is decoupled from the in-document
 * sub-page arrow (`research/2026-07-29-global-delete-hierarchy-expand-hooks.md`).
 *
 * The sidebar chevron must write ONLY the data-view primitive's device-local
 * expand map. `page_blocks.expanded` is document content — it drives inline
 * nested-page mounting in the editor — and a nav gesture must not touch it.
 * Before the decoupling both arrows wrote the same column, so collapsing a page
 * in the nav embedded its content in its parent's body and stamped `updatedAt`.
 *
 * The browser half is here; pair it with the DB half, which this script cannot
 * see (run before and after, expecting zero rows to move):
 *
 *   SELECT id, expanded, updated_at FROM page_blocks WHERE type = 'page'
 *   ORDER BY updated_at DESC LIMIT 10;
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/sidebar-expand-decoupled.ts [--headed]
 */
import {
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const STORAGE_KEY = "pages-sidebar:view-state";

const r = report("pages sidebar expand is decoupled");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("/pages"), { settleMs: 2500 });

  await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const chevrons = page.getByRole("button", { name: "Expand", exact: true });
  const count = await chevrons.count();
  r.ok("sidebar has an expandable page row", count > 0, `chevrons=${count}`);
  if (count === 0) {
    r.note("no expandable page row rendered — create a sub-page and re-run");
    return;
  }

  // The chevron is hover-revealed (opacity/pointer-events coupled), and at rest
  // the row's leading icon sits over it — so hover the row before clicking.
  const chevron = chevrons.first();
  await chevron.scrollIntoViewIfNeeded();
  await chevron.hover({ force: true });
  await chevron.click({ force: true });
  await page.waitForTimeout(1000);

  const raw = await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
  const map = raw
    ? ((
        JSON.parse(raw) as Record<
          string,
          { expanded?: Record<string, boolean> }
        >
      ).pages?.expanded ?? {})
    : {};
  const entries = Object.entries(map);

  r.ok(
    "the chevron wrote the view's OWN expand map",
    entries.length > 0,
    `${STORAGE_KEY} → ${JSON.stringify(map)}`,
  );
  r.ok(
    "the map is keyed by page block id (device-local, per view instance)",
    entries.every(([id]) => id.startsWith("block-")),
    JSON.stringify(entries.map(([id]) => id)),
  );
});

await r.finish();
