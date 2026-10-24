// Drives the Pages app's tag UI end to end on one UNTAGGED page: create a tag
// from the header's `Add tag` tool, see it as a chip under the title and as a
// dot on the page's sidebar row, then delete the tag from the picker's per-tag
// settings and see both go away (and `Add tag` come back). The tag name is
// unique per run and the script always deletes it, so it is safe to re-run.
//
// Usage:
//   ./equin run plugins/page/plugins/tags/e2e/tags-verify.ts \
//     --page <untagged pageId> [--settle 30000] [--out /tmp/tags] [--headed]
//
// Pick an untagged page:
//   select id from page_blocks b where type = 'page' and deleted_at is null
//     and not exists (select 1 from page_blocks_ext_tags t where t.parent_id = b.id) limit 1;

import {
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const pageId = requireArg("page", "usage: --page <untagged pageId>");
const settleMs = numArg("settle", 30_000);
const out = arg("out");
const name = `E2E ${Date.now().toString(36)}`;
const url = pathUrl(`/pages/page/${pageId}`);

const r = report("page tags: create, show, delete");
console.log(`url: ${url}\ntag: ${name}`);

const outcome = await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await page.goto(url);
  const title = page.locator("input.page-doc-title");
  await title.waitFor({ timeout: settleMs });

  // The hover row's tool, revealed by hovering the header.
  await title.hover();
  const addTool = page.getByRole("button", { name: "Add tag", exact: true });
  await addTool.waitFor({ timeout: settleMs });
  await addTool.click();

  const search = page.getByPlaceholder("Search or create a tag…");
  await search.fill(name);
  if (out) await page.screenshot({ path: `${out}-create.png` });
  await search.press("Enter");

  // The chip line under the title: one button, named by its chips + "Add tag".
  const line = page.getByRole("button", { name: `${name} Add tag` });
  const chipShown = await line.waitFor({ timeout: settleMs }).then(
    () => true,
    () => false,
  );
  // The sidebar marker carries the names as its tooltip.
  const marker = page.locator(`[title="${name}"]:not(button *)`);
  const dotShown = await marker
    .first()
    .waitFor({ timeout: settleMs })
    .then(
      () => true,
      () => false,
    );
  if (out) await page.screenshot({ path: `${out}-tagged.png` });

  // Delete the tag through its settings: open the picker from the chip line,
  // hover the option, `⋯`, Delete, confirm.
  await line.click();
  // The picker is a popover dialog; scope to it (the page has buttons of the
  // same names).
  const picker = page.getByRole("dialog");
  await picker.getByRole("button", { name: name, exact: true }).hover();
  await picker.getByRole("button", { name: `Edit “${name}”` }).click();
  if (out) await page.screenshot({ path: `${out}-settings.png` });
  await picker.getByRole("button", { name: "Delete", exact: true }).click();
  await picker
    .getByRole("button", { name: "Delete from every page?", exact: true })
    .click();

  const chipGone = await line
    .waitFor({ state: "detached", timeout: settleMs })
    .then(
      () => true,
      () => false,
    );
  await page.keyboard.press("Escape");
  await title.hover();
  const toolBack = await addTool.waitFor({ timeout: settleMs }).then(
    () => true,
    () => false,
  );

  return {
    chipShown,
    dotShown,
    chipGone,
    toolBack,
    pageErrors: captured.pageErrors,
    consoleErrors: captured.consoleErrors,
  };
});

r.ok("chip appears under the title", outcome.chipShown);
r.ok("dot marks the sidebar row", outcome.dotShown);
r.ok("deleting the tag removes the chip", outcome.chipGone);
r.ok("Add tag tool returns on the untagged page", outcome.toolBack);
r.ok(
  "no page errors",
  outcome.pageErrors.length === 0,
  outcome.pageErrors.join(" | "),
);
r.ok(
  "no console errors",
  outcome.consoleErrors.length === 0,
  outcome.consoleErrors.join(" | "),
);
await r.finish();
