// Verifies that a prototype opens full-surface and that its header's Back
// button returns to the gallery — both when the prototype was opened from the
// gallery and when its URL was loaded directly (the route then holds the detail
// pane alone).
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/shell/e2e/back-to-gallery.ts \
//     --name <proto-id> [--out /tmp/proto-back]

import {
  arg,
  pathUrl,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const name = requireArg(
  "name",
  "back-to-gallery.ts --name <proto-id> [--out /tmp/proto-back]",
);
const out = arg("out", "/tmp/proto-back");
const TIMEOUT = 60_000;

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  const back = page
    .locator('[data-pane-id="prototypes-detail"] button[aria-label="Back"]')
    .first();
  const gallery = page.locator('[data-pane-id="prototypes-gallery"]').first();

  await page.goto(pathUrl(`/prototypes/proto/${name}`), {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await back.waitFor({ timeout: TIMEOUT });
  if ((await gallery.count()) > 0)
    throw new Error("gallery is painted beside the prototype");
  await page.screenshot({ path: `${out}-detail.png` });
  console.log("deep link: detail full-surface, Back present");

  await back.click();
  await gallery.waitFor({ timeout: TIMEOUT });
  console.log(`after Back: ${page.url()}`);
  await page.screenshot({ path: `${out}-gallery.png` });

  await page.locator(`text=${name}`).first().click();
  await back.waitFor({ timeout: TIMEOUT });
  await back.click();
  await gallery.waitFor({ timeout: TIMEOUT });
  console.log("from gallery: open → Back → gallery OK");
});
