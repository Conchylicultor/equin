// Drives the usage stats end to end: spends a few active seconds in Mail
// (pointer input keeps the tracker non-idle), returns to Home, switches the app
// grid to its Stats table view and snapshots it.
//
//   ./equin run plugins/apps/plugins/home/plugins/usage-fields/e2e/stats-view.ts [--out /tmp/stats]
import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/usage-stats");

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(pathUrl("/home"));
  await page.getByText("Mail", { exact: true }).waitFor();
  await page.getByText("Mail", { exact: true }).click();
  // Active time: input every second for 5s.
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(200 + i * 10, 300);
    await page.waitForTimeout(1000);
  }
  // A fresh load of Home: the pagehide flush sends Mail's time.
  await page.goto(pathUrl("/home"));
  await page.getByText("Mail", { exact: true }).waitFor();
  // The view chip (labelled with the active view's name) opens the view list.
  await page
    .locator("button", { hasText: /^Apps$/ })
    .first()
    .click();
  await page.waitForTimeout(500);
  await snap(page, out, "menu");
  await page.getByText("Stats", { exact: true }).first().click();
  await page.waitForTimeout(3000);
  await snap(page, out, "stats");
});
