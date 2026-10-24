// Opens a chord-grid song from the library, switches the player to the
// "Chord grid" display and photographs it — at rest, after clicking a chord
// (which must seek there), and with the side pane's "Chord list" card. Then
// opens a song with lyrics (`--lyrics-song`, a song id), turns on the View
// popover's "Lyrics under bars" and checks the lines print under the rows
// (turned back off afterwards when this run turned it on).
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/chord-chart/e2e/chord-chart-verify.ts \
//     [--song "Blues"] [--lyrics-song <id>] [--color-scheme dark|light] \
//     [--out /tmp/chord-chart] [--headed]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const SONG = arg("song", "Blues");
const SCHEME = arg("color-scheme", "dark") === "light" ? "light" : "dark";
const OUT = arg("out", "/tmp/chord-chart");
const LYRICS_SONG = arg("lyrics-song", "79fba881-b633-44b1-b669-36ba996469a7");

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: SCHEME,
    viewport: { width: 1440, height: 900 },
  });
  const r = report(`sonata chord grid (${SONG}, ${SCHEME})`);

  await page.goto(pathUrl("/sonata"));
  await page.getByText(SONG, { exact: true }).first().click();
  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: "Chord grid" }).first().click();
  await page.waitForTimeout(2000);

  const bars = page.locator(".chord-chart-bar");
  r.ok("the chord grid shows bars", (await bars.count()) > 0);
  await snap(page, OUT, "1-grid");

  // Clicking a struck chord seeks there: its bar becomes the active one.
  const target = bars.nth(Math.min(2, (await bars.count()) - 1));
  await target.locator(".chord-box-hit").first().click();
  await page.waitForTimeout(800);
  r.ok(
    "clicking a chord makes its bar active",
    (await target.getAttribute("data-active")) !== null,
  );
  await snap(page, OUT, "2-seeked");

  // The side pane's sections start collapsed: open the chord list.
  await page.getByRole("button", { name: "Chord list" }).first().click();
  await page.waitForTimeout(800);
  const list = page.locator(".chord-list-row");
  r.ok("the chord list shows rows", (await list.count()) > 0);
  if ((await list.count()) > 0) {
    await list.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await snap(page, OUT, "3-list");
  }

  // A playing frame: the active bar outlined, its chord ringed, the beat line
  // part-way through it, the other bars receded.
  // Space toggles play on the focused player (a click on the sheet's empty
  // area focuses it without activating a chord).
  await page.mouse.click(500, 860);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  r.ok(
    "playing marks the display",
    (await page.locator("[data-playing] .chord-chart-bar").count()) > 0,
  );
  await snap(page, OUT, "4-playing");
  await page.keyboard.press("Space");

  // Lyrics under the bars: a song with lyric lines, the option switched on in
  // the View popover.
  await page.goto(pathUrl(`/sonata/song/${LYRICS_SONG}`));
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Chord grid" }).first().click();
  await page.waitForTimeout(2000);
  const lyrics = page.locator(".chord-chart-lyric");
  const toggleLyrics = async () => {
    await page.getByRole("button", { name: "Display options" }).first().click();
    await page.waitForTimeout(600);
    await page
      .locator(".cp-row", { hasText: "Lyrics under bars" })
      .first()
      .click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  };
  const wasOn = (await lyrics.count()) > 0;
  if (!wasOn) await toggleLyrics();
  r.ok("lyric lines print under the rows", (await lyrics.count()) > 0);
  r.ok(
    "a lyric row follows a row of bars",
    (await page.locator(".chord-chart-bars + .chord-chart-lyrics").count()) > 0,
  );
  await snap(page, OUT, "5-lyrics");
  if ((await lyrics.count()) > 1) {
    const line = lyrics.nth(1);
    await line.click();
    await page.waitForTimeout(800);
    r.ok(
      "clicking a lyric line seeks into it",
      (await line.getAttribute("data-active")) !== null,
    );
    await snap(page, OUT, "6-lyrics-seeked");
  }
  if (!wasOn) await toggleLyrics();

  await r.finish();
});
