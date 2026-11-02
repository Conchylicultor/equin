/**
 * The Claude account foot and its menu beside the prototype they were designed
 * from (`proto-1793450656-8cpct1`, default picks: row trigger, normal quota).
 *
 * The prototype canvas's compare frames the whole page at rest, so it never
 * sees the menu. This does: the mock and the running agent manager at the
 * mock's viewport, the closed foot photographed from each (the sidebar's
 * bottom band), then each opened and its menu photographed — and every pair
 * diffed, logging the differing-pixel ratio — and the menu once more with a
 * switch row hovered.
 *
 * Manual only. After `./equin build`:
 *
 *   ./equin run plugins/conversations/plugins/runtime-sdk/e2e/account-vs-mock.ts [--out /tmp/account]
 */
import { writeFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  arg,
  diffImages,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const PROTO = "proto-1793450656-8cpct1";
/** The mock's document, on its content host (served by the main namespace). */
const MOCK_URL = `http://${PROTO}.content.localhost:9000/equin/api/prototypes/${PROTO}/index.html`;
const VIEWPORT = { width: 1400, height: 900 };
/** The sidebar's bottom band: the foot and the rule above it. */
const FOOT = { x: 0, y: 820, width: 264, height: 80 };
const out = arg("out", "/tmp/account-vs-mock");

const r = report("account-vs-mock");

async function menuClip(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return box;
}

await withBrowser(async (h) => {
  const { page: mock } = await h.session({ viewport: VIEWPORT });
  await mock.goto(MOCK_URL);
  await mock.locator(".ac-trigger").waitFor();
  const mockFoot = await mock.screenshot({ clip: FOOT });
  await mock.locator(".ac-trigger").click();
  await mock.locator(".ac-menu").waitFor();
  await mock.waitForTimeout(300);
  const mockMenuBox = await menuClip(mock, ".ac-menu");
  const mockMenu = await mock.screenshot({ clip: mockMenuBox });

  const { page: app } = await h.session({ viewport: VIEWPORT });
  await app.goto(pathUrl("/agents"));
  const trigger = app.locator('button[aria-label="Claude account"]');
  await trigger.waitFor();
  await app.waitForTimeout(1500);
  const appFoot = await app.screenshot({ clip: FOOT });
  await trigger.click();
  await app.locator(".cp-surface").waitFor();
  await app.waitForTimeout(500);
  const appMenuBox = await menuClip(app, ".cp-surface");
  const appMenu = await app.screenshot({ clip: appMenuBox });

  // A switch row under the pointer: the whole row lights (hover fill, text
  // lifted), as the mock's settings rows do.
  await app.getByRole("switch", { name: /Resume stopped agents/ }).hover();
  await app.waitForTimeout(300);
  const hoverPath = `${out}-menu-hover.png`;
  await app.screenshot({ path: hoverPath, clip: appMenuBox });
  console.log(`wrote ${hoverPath}`);

  for (const [name, a, b] of [
    ["foot", mockFoot, appFoot],
    ["menu", mockMenu, appMenu],
  ] as const) {
    const d = await diffImages(app, a, b, { labels: ["mock", "app"] });
    for (const [suffix, png] of [
      ["mock", a],
      ["app", b],
      ["diff", d.diffPng],
      ["side-by-side", d.sideBySidePng],
    ] as const) {
      const path = `${out}-${name}-${suffix}.png`;
      writeFileSync(path, png);
      console.log(`wrote ${path}`);
    }
    console.log(
      `${name}: ${(d.ratio * 100).toFixed(2)}% of ${d.total} pixels differ` +
        ` (mock ${d.a.width}×${d.a.height}, app ${d.b.width}×${d.b.height})`,
    );
  }
  r.ok("captured and diffed the foot and the menu", true);
  await r.finish();
});
