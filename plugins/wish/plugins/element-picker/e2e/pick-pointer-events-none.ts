// E2E verification: the inspector resolves elements the app has made
// non-interactive, rather than their nearest interactive ancestor.
//
// The sharpest case is the picker's own trigger — while picking is active it
// sits inside the action bar, and any `pointer-events:none` on it (or on its
// icon glyph) makes `document.elementFromPoint` return the bar's wrapper `div`
// instead. That is the regression this guards: the overlay's highlight label
// must name `improve.element-picker · button`, not `shell.global-action-bar · div`.
//
// Usage: bun plugins/improve/plugins/element-picker/e2e/pick-pointer-events-none.ts [--url <deploy>] [--headed]
import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/pick-pointer-events-none";

await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });

  // 1. Reveal the collapsed floating action bar and arm the picker.
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
  const picker = page.getByRole("button", { name: "Pick UI element" }).first();
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  await picker.click();

  const overlay = page.locator("[data-element-picker]").first();
  await overlay.waitFor({ state: "attached", timeout: 10_000 });

  // Measure only now: the bar hover-expands over a 200ms `max-width` transition
  // (unpinned), so a box read before it settles points off-screen — past the
  // viewport's right edge, where `elementFromPoint` legitimately returns null.
  await page.waitForTimeout(400);
  const target = (await picker.boundingBox())!;

  // 2. Hover the picker button itself — the element the inspector could not see
  //    before, since arming it used to disable (and so de-hit-test) it. Approach
  //    from a neighbouring point so a real `mousemove` is guaranteed to fire.
  await page.mouse.move(target.x - 40, target.y + target.height / 2);
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
  );
  await page.waitForTimeout(200);
  await snap(page, OUT, "hover");

  const label = (await overlay.innerText()).replace(/\s+/g, " ").trim();

  // 3. Completing the pick hands the metadata to the Improve popover as a chip.
  await page.mouse.click(
    target.x + target.width / 2,
    target.y + target.height / 2,
  );
  await page.waitForTimeout(600);
  await snap(page, OUT, "picked");

  const editor = page.locator('[contenteditable="true"]').first();
  const chips = await editor.locator('button[contenteditable="false"]').count();

  const r = report("element-picker: pick a pointer-events:none control");
  r.note(`overlay label: ${JSON.stringify(label)}`);
  r.ok(
    "resolves the button, not its wrapper",
    label.includes("· button"),
    `label=${JSON.stringify(label)}`,
  );
  r.ok(
    "attributes the pick to element-picker",
    label.includes("improve.element-picker"),
    `label=${JSON.stringify(label)}`,
  );
  r.ok("pick produced a ui-context chip", chips > 0, `chips=${chips}`);
  await r.finish();
});
