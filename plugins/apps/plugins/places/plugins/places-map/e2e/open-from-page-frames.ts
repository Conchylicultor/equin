// "Open in Places" from a page's map block, filmed at REAL speed: every frame
// the compositor paints (a CDP screencast, `everyNthFrame: 1`) from the click
// until the Places map has settled, written as numbered JPEGs with their
// paint time — so a flash in the expand (a blank box, a map without tiles, a
// map drawn at another scale) can be told apart from an artifact of the
// promo film's virtual clock.
//
// For each frame it also prints what the page held at that moment, sampled
// from the page itself on every animation frame: whether a view transition
// was running, and how many Google map tiles were in the Places map.
//
// Usage (after `./equin build`, or against any deploy with `--url`):
//   ./equin run plugins/apps/plugins/places/plugins/places-map/e2e/open-from-page-frames.ts \
//     --page <pageId> [--out "$EQUIN_SCRATCH/open-frames"] [--viewport 1280x720] [--settle 3000]
//
// The page must hold a `/map` block with places on it.

import { mkdirSync, writeFileSync } from "node:fs";
import type { CDPSession } from "playwright";
import {
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const pageId = requireArg(
  "page",
  "open-from-page-frames.ts --page <pageId> [--out <dir>] [--viewport WxH] [--settle ms]",
);
const out = arg("out", "open-from-page-frames");
const [vw, vh] = arg("viewport", "1280x720").split("x").map(Number);
const settleMs = numArg("settle", 3000);
const r = report("places: open from a page map, per frame");

interface Frame {
  t: number;
  data: string;
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: vw!, height: vh! },
    colorScheme: "dark",
  });
  await page.goto(pathUrl(`/pages/page/${pageId}`));
  // The map block mounts its map once it is scrolled near: wheel down the
  // page until it is there.
  await page.getByText(/./).first().waitFor({ timeout: 60_000 });
  await page.mouse.move(vw! / 2, vh! / 2);
  const blockMap = page.locator(".gm-style").first();
  for (let i = 0; i < 60 && (await blockMap.count()) === 0; i++) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
  }
  await blockMap.waitFor({ state: "attached", timeout: 30_000 });
  await blockMap.scrollIntoViewIfNeeded();
  await blockMap.hover();
  const open = page.getByRole("button", { name: "Open in Places" }).first();
  await open.waitFor({ timeout: 10_000 });
  // Let the block's own map finish drawing its tiles before the click.
  await page.waitForTimeout(2500);

  // In-page sampler: one row per animation frame (real time).
  await page.evaluate(() => {
    const rows: { t: number; vt: boolean; tiles: number; maps: number }[] = [];
    (window as unknown as { __frames: typeof rows }).__frames = rows;
    const tick = (): void => {
      const maps = document.querySelectorAll(".gm-style");
      const last = maps[maps.length - 1];
      const tiles =
        last === undefined
          ? 0
          : [...last.querySelectorAll("img, canvas")].filter((el) => {
              if (el instanceof HTMLImageElement)
                return el.complete && el.naturalWidth > 0;
              return true;
            }).length;
      rows.push({
        t: performance.now(),
        vt: document.documentElement.hasAttribute("data-pane-morph"),
        tiles,
        maps: maps.length,
      });
      if (rows.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ t: f.metadata.timestamp ?? 0, data: f.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    everyNthFrame: 1,
  });
  await page.waitForTimeout(300);
  const clickAt = Date.now() / 1000;
  await open.click();
  await page.waitForTimeout(settleMs);
  await cdp.send("Page.stopScreencast");

  mkdirSync(out, { recursive: true });
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const name = `f${String(i).padStart(3, "0")}.jpg`;
    writeFileSync(`${out}/${name}`, Buffer.from(f.data, "base64"));
    lines.push(
      `${name}  ${((f.t - clickAt) * 1000).toFixed(0).padStart(6)} ms`,
    );
  });
  writeFileSync(`${out}/frames.txt`, lines.join("\n") + "\n");
  const samples = await page.evaluate(
    () => (window as unknown as { __frames: unknown[] }).__frames,
  );
  writeFileSync(`${out}/samples.json`, JSON.stringify(samples));
  console.log(lines.join("\n"));
  r.ok(`filmed ${frames.length} frames → ${out}`, frames.length > 0);
  await r.finish();
});
