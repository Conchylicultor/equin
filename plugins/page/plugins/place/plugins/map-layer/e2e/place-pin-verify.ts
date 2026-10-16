// Looks at the place pins on a page that has a /map block: for each pin it logs
// the drop's paint (fill, ring, shape) and whether its label sits on the head's
// centre line, then writes a close-up of the map.
//
// A transcript tool, not a gate: it fails only when the page shows no place pin.
// The page must already hold located /place blocks and a /map block, and the
// deploy needs a Google Maps browser key.
//
// Usage:
//   ./singularity run plugins/page/plugins/place/plugins/map-layer/e2e/place-pin-verify.ts \
//     --path /pages/page/<page-id> [--out /tmp/place-pin] [--headed]

import {
  arg,
  requirePage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { hoverPin, pinsOnScreen } from "@plugins/map/e2e";

const OUT = arg("out") ?? "/tmp/place-pin";

await withBrowser(async (h) => {
  const { page } = await h.session({
    // Dark app over light tiles: the case where label ink must follow the tiles.
    colorScheme: "dark",
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(
    requirePage(
      "place-pin-verify.ts --path /pages/page/<page-id> [--out /tmp/place-pin]",
    ),
  );

  const map = page.getByTestId("map");
  await map.scrollIntoViewIfNeeded({ timeout: 60_000 });
  // Pins at rest are canvas pixels; hovering one lifts it into the DOM, so the
  // look is inspected on each lifted pin in turn — its mark's inline SVG
  // (the same markup the canvas sprite is drawn from).
  // Throws when no pin appears: a page with a map but no pin is the one failure.
  const onScreen = await pinsOnScreen(page);
  await page.waitForTimeout(1500); // tiles

  const pins = [];
  for (const { label: name } of onScreen) {
    if (name.endsWith("zoom in")) continue;
    const lifted = await hoverPin(page, name);
    pins.push(
      await lifted.evaluate((root) => {
        // The head: the clipped group of the drop (its fill, veil and ring).
        const head = root.querySelector("g[clip-path]");
        const ring = head?.querySelector("path[fill='none']");
        const label = root.querySelector("[style*='text-shadow']");
        const hr = head?.getBoundingClientRect();
        const lr = label?.getBoundingClientRect();
        return {
          label: label?.textContent ?? null,
          ink: label ? getComputedStyle(label).color : null,
          // An ellipsis on a name well under the label's max width is a bug.
          truncated:
            label instanceof HTMLElement
              ? label.scrollWidth > label.clientWidth
              : null,
          fills: head
            ? [...head.querySelectorAll("rect, path:not([fill='none'])")].map(
                (el) => getComputedStyle(el).fill,
              )
            : null,
          ring: ring
            ? `${getComputedStyle(ring).strokeWidth} ${getComputedStyle(ring).stroke}`
            : null,
          headCentreY: hr ? Math.round(hr.top + hr.height / 2) : null,
          labelCentreY: lr ? Math.round(lr.top + lr.height / 2) : null,
        };
      }),
    );
  }
  if (pins.length === 0) throw new Error("the page shows no place pin");
  for (const p of pins) console.log(JSON.stringify(p));

  await map.screenshot({ path: `${OUT}-map.png` });
  console.log(`wrote ${OUT}-map.png`);
});
