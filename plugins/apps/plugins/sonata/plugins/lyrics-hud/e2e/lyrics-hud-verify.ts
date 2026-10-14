// Opens a song with lyrics (`--song`, a song id) in the piano roll, turns on
// the View popover's "Lyrics" and photographs the lyrics corner — at rest,
// while playing (the current line must move to the top of the corner) and
// after clicking a later line (which must seek there). Turns the option back
// off afterwards when this run turned it on.
//
// Usage:
//   ./singularity run plugins/apps/plugins/sonata/plugins/lyrics-hud/e2e/lyrics-hud-verify.ts \
//     [--song <id>] [--color-scheme dark|light] [--out /tmp/lyrics-hud] [--headed]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const SONG = arg("song", "song-4bb02a98-f04a-413c-802c-8ddb6c94e85d");
const SCHEME = arg("color-scheme", "dark") === "light" ? "light" : "dark";
const OUT = arg("out", "/tmp/lyrics-hud");

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: SCHEME,
    viewport: { width: 1440, height: 900 },
  });
  const r = report(`sonata lyrics corner (${SCHEME})`);

  await page.goto(pathUrl(`/sonata/song/${SONG}`));
  // The piano roll is the default display; its HUD mounts once it has drawn.
  await page
    .getByRole("button", { name: "Display options", exact: true })
    .waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);

  const corner = page.locator(".lyrics-hud");
  const viewChip = page.getByRole("button", {
    name: "Display options",
    exact: true,
  });
  const toggle = async () => {
    await viewChip.click();
    await page.waitForTimeout(600);
    await page
      .locator(".cp-panel [role=switch]")
      .filter({ hasText: "Lyrics" })
      .click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  };
  const wasOn = (await corner.count()) > 0;
  if (!wasOn) await toggle();
  r.ok("the lyrics corner shows", (await corner.count()) > 0);
  const rows = page.locator(".lyrics-hud-row");
  r.ok("it lists the song's lines", (await rows.count()) > 3);
  await snap(page, OUT, "1-rest");

  const chipTop = async () => (await viewChip.boundingBox())?.y ?? -1;
  const chipAtRest = await chipTop();
  const clock = async () =>
    (
      await page.locator("text=/^\\d+:\\d\\d\\.\\d$/").first().innerText()
    ).trim();

  // Clicking a line seeks into it (the roll's drag surface must not take the
  // press), and the corner scrolls it to its top without moving the HUD.
  await rows.nth(1).click();
  await page.waitForTimeout(1500);
  r.ok(
    "clicking a line makes it current",
    (await rows.nth(1).getAttribute("data-now")) !== null,
  );
  r.ok(
    "the HUD chips stay put",
    (await chipTop()) === chipAtRest,
    `View chip top ${chipAtRest} -> ${await chipTop()}`,
  );
  await snap(page, OUT, "2-seeked");

  // A wheel over the corner scrolls its list, not the song.
  const before = await clock();
  await corner.hover();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(800);
  r.ok("a wheel over the corner does not seek", (await clock()) === before);
  await snap(page, OUT, "3-wheeled");

  // Playing: one line is current. (Focus the roll first: Space on the
  // focused line button would click it, not play.)
  await page.mouse.click(400, 500);
  await page.keyboard.press("Space");
  await page.waitForTimeout(8000);
  r.ok(
    "a line is current while playing",
    (await page.locator(".lyrics-hud-row[data-now]").count()) === 1,
  );
  r.ok(
    "the HUD chips stay put while playing",
    (await chipTop()) === chipAtRest,
  );
  r.ok(
    "the sounding chord is marked",
    (await page
      .locator(".lyrics-hud-row[data-now] .lyrics-hud-chord-now")
      .count()) === 1,
  );
  r.ok(
    "no chord is clipped at the corner's edge",
    await corner.evaluate((el) => {
      const edge = el.getBoundingClientRect().right;
      return [...el.querySelectorAll(".lyrics-hud-chord")].every(
        (c) => c.getBoundingClientRect().right <= edge + 0.5,
      );
    }),
  );
  await snap(page, OUT, "4-playing");
  await page.keyboard.press("Space");
  await page.waitForTimeout(1000);
  // Settled: the current line is the first one the corner shows.
  const offset = await page
    .locator(".lyrics-hud-row[data-now]")
    .evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        row.parentElement!.getBoundingClientRect().top,
    );
  r.ok(
    "the current line sits at the corner's top",
    Math.abs(offset) <= 1,
    `offset ${offset}px`,
  );

  if (!wasOn) await toggle();
  await r.finish();
});
