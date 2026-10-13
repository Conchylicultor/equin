// Hovers an archive row in the file tree and checks its hover actions: Extract
// here inline, Copy path behind the row's ⋯, and the cluster's scrim covering
// the row's trailing cells rather than letting them show through the icons.
//
//   ./singularity run plugins/apps/plugins/file-explorer/plugins/browser/e2e/row-actions.ts \
//     --dir /path/to/folder --name archive.zip --out /tmp/row-actions
import {
  arg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "row-actions.ts --dir <folder> --name <archive in it> [--out <prefix>]";
const dir = requireArg("dir", USAGE);
const name = requireArg("name", USAGE);
const out = arg("out", "/tmp/file-explorer-row-actions");
const url = pathUrl(`/files/at/${encodeURIComponent(dir)}`);

await withBrowser(async (h) => {
  const r = report("File explorer row actions");
  const { page } = await h.session({
    viewport: { width: 1400, height: 900 },
    colorScheme: "dark",
  });
  await page.goto(url);
  const row = page.locator(`[data-row-key$="${name}"]`).first();
  await row.waitFor({ timeout: 60_000 });
  await row.hover();
  await page.waitForTimeout(400);

  const extract = row.getByRole("button", { name: "Extract here" });
  r.ok("Extract here shown on hover", await extract.isVisible());
  r.ok(
    "Copy path not inline",
    (await row.getByRole("button", { name: "Copy path" }).count()) === 0,
  );

  // The cluster's pin: its painted background must be opaque, else the row's
  // trailing cells show through the icons.
  const scrim = await extract.evaluate((btn) => {
    let el: Element | null = btn;
    while (el && getComputedStyle(el).position !== "absolute") {
      el = el.parentElement;
    }
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      background: cs.backgroundColor,
      image: cs.backgroundImage,
      scrimVar: cs.getPropertyValue("--scrim"),
      zIndex: cs.zIndex,
    };
  });
  console.log("pin:", JSON.stringify(scrim));
  r.ok(
    "the scrim is opaque",
    scrim !== null && !/rgba\(.*, 0(\.\d+)?\)$/.test(scrim.background),
    JSON.stringify(scrim),
  );
  await row.screenshot({ path: `${out}-row.png` });
  console.log(`wrote ${out}-row.png`);

  await row.getByRole("button", { name: "More", exact: true }).click();
  await page.waitForTimeout(400);
  r.ok(
    "Copy path in the ⋯ menu",
    await page.getByRole("button", { name: "Copy path" }).first().isVisible(),
  );
  await snap(page, out, "menu");
  await page.keyboard.press("Escape");

  // Extract here, through the button: the extracted entry appears in the
  // listing without a reload. `--name` must name a fresh archive whose
  // extraction name (one root, or the archive's stem) is not taken yet.
  const before = await page.locator("[data-row-key]").count();
  await row.hover();
  await extract.click();
  await page.waitForTimeout(2000);
  const after = await page.locator("[data-row-key]").count();
  r.ok(
    "Extract here adds the extracted entry",
    after === before + 1,
    `${before} → ${after} rows`,
  );
  await snap(page, out, "extracted");
  await r.finish();
});
