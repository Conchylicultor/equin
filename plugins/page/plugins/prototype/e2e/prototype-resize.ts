// E2E verification for resizing a page's prototype block.
// Flow: open a page holding a prototype block → drag its bottom-right corner
// in and down → assert the frame took that size, and kept it across a reload
// → double-click the corner → assert it is back to full width, 16:9.
//
// Usage: ./equin run plugins/page/plugins/prototype/e2e/prototype-resize.ts --path /pages/page/<id>
import {
  requirePage,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const PAGE = requirePage(
  "prototype-resize.ts --path /pages/page/<id> (a page holding a prototype block)",
);
const OUT = "/tmp/prototype-resize";

await withBrowser(async (h) => {
  const { page } = await h.session();
  const frame = page.locator("iframe[sandbox]").first();
  const corner = page.getByLabel("Resize prototype", { exact: true }).first();
  const box = async () => {
    const b = await frame.boundingBox();
    if (b === null) throw new Error("the prototype frame is not on screen");
    return { width: Math.round(b.width), height: Math.round(b.height) };
  };

  await page.goto(PAGE);
  await frame.waitFor({ state: "attached", timeout: 60_000 });
  await frame.scrollIntoViewIfNeeded();
  const before = await box();
  console.log("before:", before);

  // Hover first: the grip lives in the block's hover group.
  await frame.hover();
  const c = await corner.boundingBox();
  if (c === null) throw new Error("no resize corner on the prototype block");
  const x = c.x + c.width / 2;
  const y = c.y + c.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Several steps, crossing the iframe: the captured drag must follow.
  await page.mouse.move(x - 120, y + 60, { steps: 8 });
  await page.mouse.move(x - 200, y + 100, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const resized = await box();
  console.log("resized:", resized);
  await snap(page, OUT, "resized");
  if (Math.abs(before.width - 200 - resized.width) > 3) {
    throw new Error(
      `width did not follow the drag: ${JSON.stringify(resized)}`,
    );
  }
  if (Math.abs(before.height + 100 - resized.height) > 3) {
    throw new Error(
      `height did not follow the drag: ${JSON.stringify(resized)}`,
    );
  }

  await page.reload();
  await frame.waitFor({ state: "attached", timeout: 60_000 });
  await frame.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const reloaded = await box();
  console.log("after reload:", reloaded);
  if (JSON.stringify(reloaded) !== JSON.stringify(resized)) {
    throw new Error("the size did not persist across a reload");
  }

  await frame.hover();
  await corner.dblclick();
  await page.waitForTimeout(800);
  const reset = await box();
  console.log("reset:", reset);
  await snap(page, OUT, "reset");
  if (JSON.stringify(reset) !== JSON.stringify(before)) {
    throw new Error(`double-click did not reset: ${JSON.stringify(reset)}`);
  }
  console.log("PASS");
});
