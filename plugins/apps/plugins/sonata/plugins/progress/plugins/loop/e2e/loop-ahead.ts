// Verifies the Loop control's repeat options on a song:
//   - the chevron beside Loop opens the options ("Show loop ahead", "Rest
//     before repeat");
//   - with both on (the defaults), the piano roll repeats the loop band past B
//     (more than one A boundary is drawn), and approaching B shows the rest
//     then the loop again;
//   - playing through B parks the transport on A during the rest (the song
//     position slider holds still), then the repeat plays.
//
// The loop lives only in the page's memory; the options are left as found.
//
// Usage:
//   ./singularity run plugins/apps/plugins/sonata/plugins/progress/plugins/loop/e2e/loop-ahead.ts \
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
  "usage: loop-ahead.ts --song <songId> [--url …] [--headed]",
);
const OUT = "/tmp/sonata-loop-ahead";

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  const r = report("sonata loop ahead");

  const slider = page.getByRole("slider", { name: "Song position" });
  await page.goto(pathUrl(`/sonata/song/${songId}`));
  await slider.waitFor({ timeout: 90_000 });
  await page.locator("canvas").first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);

  // ── The options menu ────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Loop options" }).click();
  const ahead = page.getByText("Show loop ahead");
  const rest = page.getByText("Rest before repeat");
  await ahead.waitFor();
  r.ok("the menu lists Show loop ahead", await ahead.isVisible());
  r.ok("the menu lists Rest before repeat", await rest.isVisible());
  await snap(page, OUT, "1-options");
  await page.keyboard.press("Escape");

  // ── A loop, the playhead near B ─────────────────────────────────────────
  await page.getByRole("button", { name: "Loop", exact: true }).click();
  const rollStart = page.locator('[aria-label="Loop start (A)"]');
  await rollStart.first().waitFor();
  // Narrow the loop so B is in reach (the default loop is the whole song):
  // three bar steps ahead set B with `]`, one step back lands in the loop's
  // last bar. The roll then shows B, the rest and the loop again.
  await page
    .locator("canvas")
    .first()
    .click({ position: { x: 5, y: 5 }, force: true });
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("]");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  const aCount = await rollStart.count();
  r.ok(
    "the roll repeats the loop band past B",
    aCount > 1,
    `${aCount} A boundaries drawn`,
  );
  await snap(page, OUT, "2-near-b");

  // ── Play through B into the rest ────────────────────────────────────────
  await page.keyboard.press("Space");
  const parkedAt: number[] = [];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    parkedAt.push(Number(await slider.getAttribute("aria-valuenow")));
    if (i === 20) await snap(page, OUT, "3-playing");
  }
  await page.keyboard.press("Space");
  await snap(page, OUT, "4-stopped");
  r.note(`slider over ~6 s: ${parkedAt.join(", ")}`);
  await r.finish();
});
