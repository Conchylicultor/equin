// Opens a host media file (video or audio) in the File Explorer and reports
// the player's state — whether it auto-played, and whether Space pauses and
// resumes it — or the No preview fallback when the browser cannot decode it.
// Manual only.
//
// Usage:
//   ./equin run plugins/primitives/plugins/file-viewer/plugins/media/e2e/media-verify.ts \
//     --file ~/Downloads/clip.mp4 [--out /tmp/media]
import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const file = arg("file");
if (!file) throw new Error("--file <host path> is required");
const out = arg("out", "/tmp/media-verify");
// The explorer's route: the folder as one encoded segment, then the name.
const slash = file.lastIndexOf("/");
const url = pathUrl(
  `/files/at/${encodeURIComponent(file.slice(0, slash))}/${encodeURIComponent(file.slice(slash + 1))}`,
);

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  const media = page.locator("video, audio");
  const fallback = page.getByText(/No preview for/);
  await media.or(fallback).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  if (await fallback.isVisible()) {
    console.log("state: No preview fallback (browser could not decode)");
    await snap(page, out, "media");
    return;
  }
  const read = () =>
    media.evaluate((m: HTMLMediaElement) => ({
      tag: m.tagName.toLowerCase(),
      readyState: m.readyState,
      duration: m.duration,
      paused: m.paused,
      error: m.error?.code ?? null,
    }));
  console.log("opened:      ", JSON.stringify(await read()));
  await snap(page, out, "media");
  // Space from the page (focus off the player) toggles playback.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  const before = (await read()).paused;
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  const after = (await read()).paused;
  console.log(`space:        paused ${before} → ${after}`);
  if (before === after) throw new Error("Space did not toggle playback");
});
