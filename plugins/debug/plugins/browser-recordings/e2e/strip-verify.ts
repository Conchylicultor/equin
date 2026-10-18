// Shows the browser-recording filmstrip of a conversation: opens the conversation,
// scrolls its transcript up until a recording strip is on screen, asserts it
// has thumbnails, and screenshots it.
//
// Usage:
//   ./singularity run plugins/debug/plugins/browser-recordings/e2e/strip-verify.ts \
//     --conversation <conv-id> [--out /tmp/strip] --no-record

import {
  arg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const conversation = requireArg(
  "conversation",
  "usage: strip-verify.ts --conversation <conv-id> [--out <prefix>] --no-record",
);
const out = arg("out", "/tmp/strip");
const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 1000 } });
  await page.goto(pathUrl(`/agents/c/${conversation}`), {
    waitUntil: "domcontentloaded",
  });
  const scroller = page.locator("[data-pane-scroll]").first();
  await scroller.waitFor({ state: "visible", timeout: 30_000 });
  const strip = page.locator("[data-browser-recording]");
  // The transcript opens at its end; walk up until a strip renders.
  for (let i = 0; i < 80 && (await strip.count()) === 0; i++) {
    await scroller.evaluate((el) => el.scrollBy(0, -900));
    await page.waitForTimeout(150);
  }
  r.ok("a recording strip renders", (await strip.count()) > 0);
  if ((await strip.count()) === 0) return r.finish();
  const last = strip.last();
  await last.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const thumbs = await last.locator("img").count();
  console.log(`strips: ${await strip.count()}, thumbnails in last: ${thumbs}`);
  r.ok("the strip shows thumbnails", thumbs > 0);
  await snap(page, out, "strip");
  await r.finish();
});
