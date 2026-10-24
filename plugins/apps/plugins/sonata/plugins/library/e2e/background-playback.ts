// Verifies playback that outlives the player pane:
//   - a song played in the player keeps playing after ← Library, and the
//     library shows it (the now-playing bar, Pause on its card);
//   - reopening it from the bar's title shows it still playing (not reloaded,
//     so not stopped and rewound);
//   - the bar's toggle pauses it from the library.
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/library/e2e/background-playback.ts \
//     --song <songId> [--url http://<worktree>.localhost:9000] [--headed]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/sonata-background-playback";
const songId = arg("song");
if (!songId) throw new Error("--song <songId> is required");

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: "dark",
    // Wide enough that the player header keeps Play out of its overflow menu.
    viewport: { width: 1920, height: 1000 },
  });
  const r = report("sonata background playback");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const play = page.getByRole("button", { name: "Play", exact: true });
  const nowPlaying = page.getByText("Now playing", { exact: true });

  await page.goto(pathUrl(`/sonata/song/${songId}`));
  await play.first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await play.first().click();
  await page.waitForTimeout(1500);
  r.ok("the player plays", (await pause.count()) > 0);
  await snap(page, OUT, "1-playing");

  await page
    .getByRole("button", { name: /Library/ })
    .first()
    .click();
  await nowPlaying.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  r.ok("back on the library", new URL(page.url()).pathname === "/sonata");
  r.ok("the now-playing bar shows", (await nowPlaying.count()) === 1);
  // The bar's toggle and the playing song's card action both read Pause.
  r.ok("the library shows it playing", (await pause.count()) >= 2);
  await snap(page, OUT, "2-library");

  await page.getByRole("button", { name: /^Open .* in player$/ }).click();
  await page.waitForTimeout(2000);
  r.ok("reopened the player", page.url().includes(`/sonata/song/${songId}`));
  r.ok("still playing after reopening", (await pause.count()) > 0);
  await snap(page, OUT, "3-reopened");

  await page
    .getByRole("button", { name: /Library/ })
    .first()
    .click();
  await nowPlaying.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await pause.first().click();
  await page.waitForTimeout(800);
  r.ok("the bar pauses it", (await pause.count()) === 0);
  r.ok("the bar stays while paused", (await nowPlaying.count()) === 1);
  await snap(page, OUT, "4-paused");

  await r.finish();
});
