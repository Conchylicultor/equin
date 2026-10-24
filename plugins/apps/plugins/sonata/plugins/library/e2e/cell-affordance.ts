// Verifies the library table's two competing gestures on one cell:
//   - clicking a song's TITLE opens the song (the row's own action);
//   - the pencil revealed on hover — and only it — opens the inline editor.
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/library/e2e/cell-affordance.ts
//     [--url http://<worktree>.localhost:9000] [--headed]

import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/sonata-cell-affordance";

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  const r = report("sonata library cell affordance");

  await page.goto(pathUrl("/sonata"));
  // The "All" view is the table one; Cards is the default.
  // `.last()`: the switcher chip is also wrapped in a sortable drag handle
  // that carries the same accessible name.
  await page.getByRole("button", { name: "All", exact: true }).last().click();
  await page.waitForTimeout(2500);

  // The Composer column is editable and rarely long, so its pencil is the one
  // to aim at; the Title cell is the one whose click must reach the row.
  const composer = page.getByLabel("Edit Composer").first();
  // The cell around it — what the pointer is actually over when the pencil
  // shows. Hovering the pencil itself is impossible at rest, and that is the
  // point: `pointer-events: none` means the hidden button is not a live
  // click-target sitting over the row (Playwright reports the cell as
  // intercepting, which IS the assertion).
  const cell = composer.locator("..");
  const pencilOpacity = async () =>
    await composer.evaluate((el) => getComputedStyle(el).opacity);

  r.ok("pencil is hidden at rest", (await pencilOpacity()) === "0");

  await cell.hover();
  await page.waitForTimeout(400);
  r.ok("pencil is revealed on hover", (await pencilOpacity()) === "1");
  await snap(page, OUT, "1-hover");

  // The pencil opens the editor, and does NOT open the song.
  const urlBefore = page.url();
  await composer.click();
  await page.waitForTimeout(600);
  const editorOpen = (await page.locator("input:focus").count()) > 0;
  r.ok("pencil opens the inline editor", editorOpen);
  r.ok("pencil did not open the song", page.url() === urlBefore);
  await snap(page, OUT, "2-editing");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // The value itself belongs to the row: clicking the title opens the song.
  await page.getByText("A Star Is Born - Shallow", { exact: true }).click();
  await page.waitForTimeout(1500);
  r.ok("clicking the title opened the song", page.url() !== urlBefore);
  await snap(page, OUT, "3-opened");

  await r.finish();
});
