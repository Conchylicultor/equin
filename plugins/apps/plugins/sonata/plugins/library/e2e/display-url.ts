// Verifies the player's display lens lives in the URL (`;lens`):
//   - picking a lens writes `;lens=<id>` into the address, in place;
//   - a reload of that address reopens the same lens;
//   - picking the default lens drops the key again;
//   - a `;bar` link opens with both keys, and switching lens keeps the bar.
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/library/e2e/display-url.ts \
//     --song <songId> [--url http://<worktree>.localhost:9000] [--headed]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/sonata-display-url";
const songId = arg("song");
if (!songId) throw new Error("--song <songId> is required");

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: "dark",
    // Wide enough that the header keeps the display picker out of its overflow.
    viewport: { width: 1920, height: 1000 },
  });
  const r = report("sonata display lens in the URL");
  // The header's display switcher is a segmented control: one radio per lens.
  const lens = (name: string) =>
    page.getByRole("radio", { name, exact: true }).first();
  const pressed = async (name: string) =>
    (await lens(name).getAttribute("aria-checked")) === "true";
  const path = () => decodeURIComponent(new URL(page.url()).pathname);

  await page.goto(pathUrl(`/sonata/song/${songId}`));
  await lens("Notation").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  const defaultLens = (await pressed("Piano Roll")) ? "Piano Roll" : null;
  r.ok("opens bare, on the default lens", !path().includes(";lens="));

  await lens("Notation").click();
  await page.waitForTimeout(800);
  r.ok("picking a lens writes ;lens", path().endsWith(";lens=notation"));
  r.ok("the picked lens is on", await pressed("Notation"));
  await snap(page, OUT, "1-picked");

  await page.reload();
  await lens("Notation").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  r.ok("a reload keeps ;lens", path().endsWith(";lens=notation"));
  r.ok("a reload reopens the lens", await pressed("Notation"));
  await snap(page, OUT, "2-reloaded");

  if (defaultLens) {
    await lens(defaultLens).click();
    await page.waitForTimeout(800);
    r.ok("the default lens drops ;lens", !path().includes(";lens="));
  }

  await page.goto(pathUrl(`/sonata/song/${songId};bar=5;lens=notation`));
  await lens("Notation").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  r.ok("a ;bar;lens link opens on its lens", await pressed("Notation"));
  r.ok(
    "the playhead is not at the start",
    !(await page.getByText(/^0:00\.0 \//).count()),
  );
  await snap(page, OUT, "3-bar");
  await lens("Songsheet").click();
  await page.waitForTimeout(800);
  r.ok("switching lens keeps ;bar", path().endsWith(";bar=5;lens=songsheet"));

  await r.finish();
});
