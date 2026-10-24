// Drives the light/dark switch against the deployed app and prints what the page
// actually did: the `<html>.dark` class and the switch's own checked state,
// before and after one click.
//
// It exists because the toggle's read and its write are two different config
// calls, and when they name different scopes the switch still renders, still
// looks clickable, and changes nothing on screen — a failure no static check
// sees. Reading the class is what makes that visible.
//
// The control now lives INSIDE the quick-theme popover, so the script opens the
// popover first — which also covers the other way this can break: the row is a
// contribution, so a section that fails to render leaves the app with no way to
// change scheme at all.
//
// Usage:
//   ./equin run plugins/ui/plugins/theme-toggle/e2e/theme-toggle-verify.ts [--url http://<worktree>.localhost:9000]

import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/theme-toggle";

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  const row = () => page.getByRole("switch", { name: "Dark mode" }).first();
  const isDark = () =>
    page.evaluate(() => document.documentElement.classList.contains("dark"));
  const checked = async () =>
    (await row().getAttribute("aria-checked")) === "true";

  // On a cold cache the pre-paint script paints the OS's scheme as a floor and
  // the class applier corrects it once React mounts and config hydrates — around
  // 3s in, which a fixed wait straddles. So wait for the two to AGREE rather than
  // for a duration; if they never do, the poll gives up and the assertions below
  // report the disagreement as the failure it is.
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if ((await checked()) === (await isDark())) return;
      await page.waitForTimeout(500);
    }
  }

  await page.goto(pathUrl("/agents"));

  // Unpinned, the action bar is a hover-revealed floating panel in the top-right
  // corner: its collapsed hitbox covers the buttons until the pointer is over it,
  // so hovering a button directly never lands. Move to the corner first, let the
  // panel open, then open the theme popover the switch lives in.
  const box = page.viewportSize() ?? { width: 1400, height: 900 };
  await page.mouse.move(box.width - 24, 20);
  await page.waitForTimeout(600);
  // `aria-label`, not `getByRole(name:)`: "Theme" is a common accessible name
  // (task rows, section headings), and the role query matched four of them.
  await page.locator('button[aria-label="Theme"]').click();

  await row().waitFor({ timeout: 30_000 });
  await settle();

  const darkBefore = await isDark();
  const checkedBefore = await checked();
  console.log(`before: html.dark=${darkBefore} switch=${checkedBefore}`);
  await snap(page, OUT, "before");

  await row().click();
  await page.waitForTimeout(1200);
  await settle();

  const darkAfter = await isDark();
  const checkedAfter = await checked();
  console.log(`after:  html.dark=${darkAfter} switch=${checkedAfter}`);
  await snap(page, OUT, "after");

  // The switch describes the scheme on screen, so both must move together: a
  // switch that flips while the class does not is exactly the bug this script is
  // for.
  const r = report("theme-toggle");
  r.ok(
    "one click flips the page",
    darkAfter !== darkBefore,
    `html.dark stayed ${darkBefore}`,
  );
  r.eq("switch before describes the page", checkedBefore, darkBefore);
  r.eq("switch after describes the page", checkedAfter, darkAfter);
  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
