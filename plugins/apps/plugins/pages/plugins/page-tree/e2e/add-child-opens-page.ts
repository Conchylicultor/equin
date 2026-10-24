/**
 * Verifies that creating a page from the sidebar tree OPENS it.
 *
 * A row's hover "+" ("Add child") creates the page and asks the tree to
 * activate it by the id the create returned — one live-state round-trip before
 * the row itself lands. The data-view tree layer used to drop an activation it
 * could not resolve to a row yet, so the page was created and the user stayed
 * on whatever was already open. It now holds the id and activates on arrival.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/add-child-opens-page.ts [--headed]
 */
import {
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("sidebar add-child opens the new page");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("/pages"), { settleMs: 2500 });

  const before = page.url();

  // The "+" is hover-revealed on its row, so hover the row first.
  const rows = page.locator("[data-tree-row], [class*='group/tree-row']");
  const row = rows.first();
  await row.scrollIntoViewIfNeeded();
  await row.hover({ force: true });

  const add = page.getByRole("button", { name: "Add child", exact: true });
  const count = await add.count();
  r.ok("a row exposes the Add child button", count > 0, `buttons=${count}`);
  if (count === 0) return;

  await add.first().click({ force: true });
  await page.waitForTimeout(3000);

  const after = page.url();
  r.ok(
    "the URL moved to the freshly created page",
    after !== before && /\/pages\/page\/block-/.test(after),
    `before=${before}\n      after=${after}`,
  );
});

await r.finish();
