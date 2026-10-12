// Verifies the progress bar's hover affordances on a song with sections:
//   - hovering the track shows the preview (time first), the preview is the
//     topmost thing at its own centre — no neighbouring chrome (the player's
//     top bar) paints over it — and it covers neither the rail nor the labels;
//   - hovering a section's label reveals its "Loop this section" button at the
//     right end of the section's lane group, and lights up its rail segment.
//
// Read-only: nothing is clicked, so nothing is left behind.
//
// Usage:
//   ./singularity run plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/e2e/hover.ts \
//     --song <songId> [--url http://<namespace>.localhost:9000] [--headed]

import {
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const songId = requireArg(
  "song",
  "usage: hover.ts --song <songId> [--url …] [--headed]",
);
const OUT = "/tmp/sonata-progress-hover";

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  const r = report("sonata progress hover");

  const slider = page.getByRole("slider", { name: "Song position" });
  await page.goto(pathUrl(`/sonata/song/${songId}`));
  await slider.waitFor({ timeout: 90_000 });
  await page.locator("canvas").first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await snap(page, OUT, "1-rest");

  // ── Track hover: the preview shows and is not covered ────────────────────
  const track = await slider.boundingBox();
  if (!track) throw new Error("slider has no box");
  await page.mouse.move(
    track.x + track.width * 0.4,
    track.y + track.height / 2,
  );
  const preview = page.getByText(/^\d+:\d\d\.\d$/).last();
  await preview.waitFor({ timeout: 5_000 });
  const box = await preview.boundingBox();
  if (!box) throw new Error("preview has no box");
  const onTop = await preview.evaluate(
    (el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return (
        hit !== null && (el === hit || el.contains(hit) || hit.contains(el))
      );
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  r.ok("the hover preview is the topmost element at its centre", onTop);
  const lane = await slider.locator("xpath=..").boundingBox();
  if (!lane) throw new Error("slider column has no box");
  r.ok(
    "the hover preview covers neither the rail nor the labels",
    box.y >= lane.y + lane.height || box.y + box.height <= lane.y,
    `preview ${box.y.toFixed(0)}–${(box.y + box.height).toFixed(0)}, column ${lane.y.toFixed(0)}–${(lane.y + lane.height).toFixed(0)}`,
  );
  await snap(page, OUT, "2-track-hover");

  // ── Section label hover: loop button revealed, segment lit ───────────────
  const loops = page.getByRole("button", { name: "Loop this section" });
  const count = await loops.count();
  r.ok("the song has section labels", count > 0, `${count} loop buttons`);
  if (count > 1) {
    const loop = loops.nth(1);
    const lbox = await loop.boundingBox();
    if (!lbox) throw new Error("loop button has no box");
    // Hover the left end of the section's lane group (its label), not the button.
    const label = page
      .getByRole("button", { name: "Loop this section" })
      .nth(1)
      .locator("xpath=ancestor::*[contains(@class,'group/hover-reveal')][1]");
    const gbox = await label.boundingBox();
    if (!gbox) throw new Error("lane group has no box");
    await page.mouse.move(gbox.x + 8, gbox.y + gbox.height / 2);
    await page.waitForTimeout(800); // let the reveal transition finish
    const opacity = await loop.evaluate(
      (el) => getComputedStyle(el.closest("span") ?? el).opacity,
    );
    r.eq("hovering the label reveals its loop button", opacity, "1");
    r.ok(
      "the loop button sits at the right end of the section",
      lbox.x + lbox.width >= gbox.x + gbox.width - 8,
      `button ends at ${(lbox.x + lbox.width).toFixed(1)}, group at ${(gbox.x + gbox.width).toFixed(1)}`,
    );
    r.ok(
      "a rail segment is lit",
      (await page.locator("[data-hot]").count()) === 1,
    );
    await snap(page, OUT, "3-label-hover");
  }

  await r.finish();
});
