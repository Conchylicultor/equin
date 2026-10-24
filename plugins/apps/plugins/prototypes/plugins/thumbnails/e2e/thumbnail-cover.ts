// Reads the prototypes gallery and reports, per card, whether its cover is a
// rendered thumbnail and whether that image FILLS its frame (the letterboxing
// this script exists to catch is invisible in a 200px-wide card screenshot).
// A transcript tool, not a gate: it logs.
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/thumbnails/e2e/thumbnail-cover.ts \
//     [--url http://<worktree>.localhost:9000]

import {
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/prototype-thumbnails";

interface CoverReport {
  src: string;
  natural: [number, number];
  drawn: [number, number];
  frame: [number, number];
  objectFit: string;
  /** Does the image cover its frame, within a pixel of rounding? */
  fills: boolean;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });

  await page.goto(pathUrl("/prototypes"));
  // Wait for the CONDITION, not a fixed delay: a cold SPA boot in a fresh
  // browser profile regularly takes longer than any timeout worth hardcoding,
  // and a short one reports "no thumbnails" for a gallery that simply had not
  // painted yet.
  await page
    .locator("img[src*='prototype-thumbs'], :text('Preview failed')")
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(500);

  // The failure marker is the state a picture alone cannot show — and it is
  // only doing its job if it is actually ON the card, so report where it sits
  // relative to the cover it belongs to.
  const markers = await page.getByText("Preview failed").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      const cover = el.closest("div.relative")?.getBoundingClientRect();
      return {
        rect: [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ],
        insideCover:
          cover !== undefined &&
          rect.bottom <= cover.bottom + 1 &&
          rect.right <= cover.right + 1 &&
          rect.width > 0,
      };
    }),
  );
  console.log(`cards reporting "Preview failed": ${markers.length}`);
  for (const marker of markers) {
    console.log(
      `  marker rect=${marker.rect.join(",")} insideCover=${marker.insideCover}`,
    );
  }

  const covers: CoverReport[] = await page
    .locator("img[src*='prototype-thumbs']")
    .evaluateAll((els) =>
      els.map((el) => {
        const img = el as HTMLImageElement;
        const rect = img.getBoundingClientRect();
        const parent = img.parentElement as HTMLElement;
        // The frame's CONTENT box, not its bounding rect: the cover sits inside
        // a 1px-bordered Clip, so a bounding-rect comparison reports a 2px
        // shortfall on an image that fills perfectly.
        const frame: [number, number] = [
          parent.clientWidth,
          parent.clientHeight,
        ];
        return {
          src: img.getAttribute("src") ?? "",
          natural: [img.naturalWidth, img.naturalHeight] as [number, number],
          drawn: [Math.round(rect.width), Math.round(rect.height)] as [
            number,
            number,
          ],
          frame,
          objectFit: getComputedStyle(img).objectFit,
          fills: rect.width >= frame[0] - 1 && rect.height >= frame[1] - 1,
        };
      }),
    );

  console.log(`thumbnails on screen: ${covers.length}`);
  for (const cover of covers) {
    console.log(
      `  ${cover.src.split("/").pop()} natural=${cover.natural.join("x")} ` +
        `drawn=${cover.drawn.join("x")} frame=${cover.frame.join("x")} ` +
        `object-fit=${cover.objectFit} fills=${cover.fills}`,
    );
  }

  const failures = covers.filter((c) => !c.fills);
  if (failures.length > 0) {
    console.log(
      `\n${failures.length} cover(s) do NOT fill their frame — the card is letterboxing.`,
    );
  }

  await snap(page, OUT, "gallery");
});
