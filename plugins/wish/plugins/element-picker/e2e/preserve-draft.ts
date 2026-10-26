// E2E verification: picking a UI element ADDS to the Improve draft, never
// replaces it — from both entry points.
//
// The ActionBar picker used to hand the tag over as seed text, which the draft
// popover applied by overwriting the head card. Since cards are persisted, that
// silently destroyed whatever the user had already written. Both pickers now go
// through one insertion funnel.
//
// Flow: type a draft → pick an element with the popover OPEN (caret path) → pick
// again with the popover CLOSED (append path, draft restored from localStorage)
// → assert the typed text survived both and each pick added its own chip.
//
// Usage: bun plugins/improve/plugins/element-picker/e2e/preserve-draft.ts [--url <deploy>] [--headed]
import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/element-picker-preserve-draft";
const DRAFT = "please fix the thing";

// Somewhere in the app rail / sidebar — well clear of the top-right action bar
// and the popover anchored under it, so the pick lands on real app UI.
const PICK_AT = { x: 20, y: 300 };

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });

  // The action bar floats collapsed at the top-right unless it is pinned into
  // the tab bar: the floating one is hovered open, the pinned one is already.
  const bar = page.locator('[data-source*="floating-action"]').first();
  const revealBar = async () => {
    if (await bar.isVisible()) await bar.hover();
  };
  await page
    .getByRole("button", { name: "Wish" })
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  await revealBar();

  const improve = page.getByRole("button", { name: "Wish" }).first();
  await improve.waitFor({ state: "visible", timeout: 10_000 });
  const picker = page.getByRole("button", { name: "Pick UI element" }).first();
  const editor = () => page.locator('[contenteditable="true"]').first();
  const chips = () => editor().locator('button[contenteditable="false"]');

  // Type a draft in the Improve popover.
  await improve.click();
  await editor().waitFor({ state: "visible", timeout: 10_000 });
  await editor().click();
  await page.keyboard.type(DRAFT);
  await snap(page, OUT, "drafted");

  // Pick #1 — popover still open: the tag goes in at the caret.
  await revealBar();
  await picker.click();
  await page.mouse.move(PICK_AT.x, PICK_AT.y);
  await page.mouse.click(PICK_AT.x, PICK_AT.y);
  await page.waitForTimeout(800);
  await snap(page, OUT, "picked-open");

  const afterOpen = (await editor().innerText()).trim();
  const chipsAfterOpen = await chips().count();

  // Pick #2 — popover closed: the draft is restored from localStorage and the
  // tag is appended to it.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await revealBar();
  await picker.click();
  await page.mouse.move(PICK_AT.x, PICK_AT.y);
  await page.mouse.click(PICK_AT.x, PICK_AT.y);
  await page.waitForTimeout(800);
  await snap(page, OUT, "picked-closed");

  const afterClosed = (await editor().innerText()).trim();
  const chipsAfterClosed = await chips().count();

  const r = report("element-picker: picks add to the draft, never replace it");
  r.note(
    `after open-popover pick:  ${JSON.stringify(afterOpen)} (chips=${chipsAfterOpen})`,
  );
  r.note(
    `after closed-popover pick: ${JSON.stringify(afterClosed)} (chips=${chipsAfterClosed})`,
  );
  r.ok(
    "draft survives a pick with the popover open",
    afterOpen.includes(DRAFT),
  );
  r.ok(
    "that pick added a chip",
    chipsAfterOpen === 1,
    `chips=${chipsAfterOpen}`,
  );
  r.ok(
    "draft survives a pick with the popover closed",
    afterClosed.includes(DRAFT),
  );
  r.ok(
    "that pick added a second chip",
    chipsAfterClosed === 2,
    `chips=${chipsAfterClosed}`,
  );
  r.ok(
    "no literal tag text leaked into the editor",
    !afterClosed.includes("<ui-context"),
  );
  await r.finish();
});
