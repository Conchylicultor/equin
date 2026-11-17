// Reload drill: a half-written wish survives a reload.
//
// Opens the Wish popover from the action bar, types a wish without filing it,
// and runs the reload drill (`e2e-harness` reload-drill.ts): the composer's
// text is work (kept-state), so after the reload — and reopening Wish, a popup
// being closed by a reload by design unless its kept open flag reopens it —
// the composer holds the same text. Clears the draft at the end so the
// throwaway browser leaves nothing behind (its storage dies with it anyway).
//
// Usage: ./equin run plugins/wish/e2e/reload-drill.ts [--no-record] [--headed] [--attach <ticket>]
import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  reloadDrill,
  reloadDrillText,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/wish-reload-drill";
const WISH = "make the sidebar remember its width when I";

/** The popover's composer (the first editable inside the open overlay panel). */
const composer = (page: Page) =>
  page.locator('[data-overlay-panel] [contenteditable="true"]').first();

/** Open Wish unless it is already open (its open flag is kept view state). */
async function openWish(page: Page): Promise<void> {
  if (await composer(page).isVisible()) return;
  // The action bar floats collapsed unless pinned: hover it open first.
  const bar = page.locator('[data-source*="floating-action"]').first();
  const wish = page.getByRole("button", { name: "Wish" }).first();
  await wish.waitFor({ state: "attached", timeout: 60_000 });
  if (await bar.isVisible()) await bar.hover();
  await wish.click();
  await composer(page).waitFor({ state: "visible", timeout: 15_000 });
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  const r = report("wish: a half-written wish survives a reload");
  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });

  const drill = await reloadDrill(page, {
    step: async (p) => {
      await openWish(p);
      await composer(p).click();
      await p.keyboard.type(WISH);
    },
    restore: openWish,
    within: "[data-overlay-panel]",
  });
  console.log(reloadDrillText(drill));
  await snap(page, OUT, "after-reload");

  const text = (await composer(page).innerText()).trim();
  r.ok(
    "the composer shows the wish after the reload",
    text.includes(WISH),
    JSON.stringify(text),
  );
  r.ok(
    "the reload gave everything back",
    drill.differences.length === 0 && drill.compared > 0,
    reloadDrillText(drill),
  );
  await r.finish();
});
