// Opens one saved place's card on THIS checkout's deploy and screenshots it —
// to look at a place as the user sees it (its note, tags, details). Read-only.
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/open-card.ts \
//     --place "German Historical Museum" [--wait 20000] [--out /tmp/places-card]
//
// Writes `<out>-card.png`; prints the card's note.

import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/places-card");
const name = arg("place", "");
const settle = Number(arg("wait", "20000"));
if (name === "") throw new Error("--place <displayed name> is required");

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 120_000 });
  await page.waitForTimeout(settle);

  await page.getByPlaceholder("Search places").fill(name);
  await page.waitForTimeout(3000);
  await page.locator(`[role="button"][aria-label="${name}"]`).first().click();
  const note = page.getByLabel("Note", { exact: true });
  await note.waitFor({ timeout: 30_000 });
  console.log(`note:\n${await note.inputValue()}`);
  const box = await note.boundingBox();
  console.log(
    `note box: ${box === null ? "not laid out" : `${Math.round(box.height)} px tall`}, scrollHeight ${await note.evaluate((el) => el.scrollHeight)} px`,
  );
  await snap(page, out, "card");
});
