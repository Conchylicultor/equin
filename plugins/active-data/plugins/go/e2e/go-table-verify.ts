// Verifies a `<go>` pick table end to end, without sending anything:
//   1. the table renders, a box leading each row's first cell;
//   2. clicking anywhere on a row toggles its pick;
//   3. the header's box checks every row (then clears them all);
//   4. ✎ puts the picks in the draft as a checklist of first cells — not the
//      table (the draft is cleared afterwards).
//
// The conversation must hold an assistant reply with a `<go>` pick table.
//
// Usage:
//   ./singularity run plugins/active-data/plugins/go/e2e/go-table-verify.ts \
//     --conv <conversationId> [--out /tmp/go-table] [--headed]

import {
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = requireArg(
  "conv",
  "usage: go-table-verify.ts --conv <conversationId>",
);
const OUT = arg("out", "/tmp/go-table");
const waitMs = numArg("wait", 8000);

const r = report("active-data go table");

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1280, height: 1000 } });
  await page.goto(pathUrl(`/agents/c/${CONV}`));
  await page.waitForTimeout(waitMs);

  // The transcript is windowed: only replies near the viewport are mounted, so
  // scroll up through it until the table's reply mounts.
  const table = page.locator("table:has(th [role=checkbox])").last();
  await page.mouse.move(700, 450);
  for (let i = 0; i < 80 && (await table.count()) === 0; i++) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(400);
  }
  r.ok("a pick table rendered", (await table.count()) > 0);
  if ((await table.count()) === 0) return;
  await table.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await snap(page, OUT, "reply");

  const boxes = table.locator("tbody [role=checkbox]");
  const picks = async () =>
    boxes.evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-checked")),
    );
  r.note(`rows: ${JSON.stringify(await picks())}`);
  r.ok("each row leads with a box", (await boxes.count()) > 0);

  // A click on the LAST cell, away from the box, is still the row's toggle.
  const firstRow = table.locator("tbody tr").first();
  const before = await boxes.first().getAttribute("aria-checked");
  await firstRow.locator("td").last().click();
  await page.waitForTimeout(300);
  r.ok(
    "clicking anywhere on a row toggles it",
    (await boxes.first().getAttribute("aria-checked")) !== before,
  );

  const headBox = table.locator("th [role=checkbox]");
  await headBox.click();
  await page.waitForTimeout(300);
  const afterAll = await picks();
  if (afterAll.every((p) => p === "true")) {
    r.ok("the header box checks every row", true);
  } else {
    // Every row was already checked: the click cleared them; check again.
    r.ok(
      "the header box clears every row when all were checked",
      afterAll.every((p) => p === "false"),
    );
    await headBox.click();
    await page.waitForTimeout(300);
    r.ok(
      "the header box checks every row",
      (await picks()).every((p) => p === "true"),
    );
  }
  await snap(page, OUT, "all-checked");

  // ✎ — the card's edit cap — hands the picks to the draft as a checklist.
  const card = table.locator(
    "xpath=ancestor::*[.//*[@aria-label='Edit in the prompt']][1]",
  );
  await card.locator('[aria-label="Edit in the prompt"]').click();
  await page.waitForTimeout(500);
  const editor = page.locator('[contenteditable="true"]').last();
  const draft = await editor.innerText();
  r.note(`draft: ${JSON.stringify(draft)}`);
  r.ok("the draft holds no table", !draft.includes("|"));
  const firstCells = await table
    .locator("tbody td:first-child")
    .evaluateAll((tds) =>
      tds.map((td) => (td as HTMLElement).innerText.trim()),
    );
  r.ok(
    "the draft names every checked row by its first cell",
    firstCells.every((cell) => draft.includes(cell.replace(/\*/g, ""))),
  );
  await snap(page, OUT, "draft");
  // Leave no draft behind.
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
});
