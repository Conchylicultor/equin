// Shows the place cards' opening hours: Places in Gallery view, then the
// setting that reveals them written as the Config pane writes it, captured
// before / during / after. Writes to the deploy it drives — run it on a
// composition of your own (`--composition promo-film`), never main.
//
// Usage:
//   ./equin run plugins/apps/plugins/places/plugins/places-map/e2e/opening-hours.ts \
//     --composition promo-film [--out /tmp/hours]

import {
  arg,
  pageFetch,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/hours");
const STORE = "apps/places/places-map/place-cards.jsonc";

async function setHours(
  page: Parameters<typeof pageFetch>[0],
  value: boolean,
): Promise<void> {
  const res = await pageFetch(page, "/api/config-v2/set-field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storePath: STORE, key: "showOpeningHours", value }),
  });
  if (!res.ok) throw new Error(`set-field ${res.status}: ${await res.text()}`);
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1400, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByPlaceholder("Search or add places")
    .waitFor({ timeout: 120_000 });
  await setHours(page, false);
  await page.getByRole("radio", { name: "Gallery" }).click();
  await page.waitForTimeout(4000);
  await snap(page, out, "before");
  await setHours(page, true);
  await page.waitForTimeout(250);
  await snap(page, out, "during");
  await page.waitForTimeout(6000);
  await snap(page, out, "after");
  console.log(
    `hours lines: ${await page.getByText(/^(Open|Closed today)/).count()}`,
  );
  await setHours(page, false);
});
