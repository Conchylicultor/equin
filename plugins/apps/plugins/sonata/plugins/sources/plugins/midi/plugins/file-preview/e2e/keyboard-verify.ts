// Verifies the keyboard transport reaches a player outside the Sonata app: in
// the file explorer's MIDI preview, Space toggles play/pause and ←/→ jump the
// playhead a bar (the shown player's `SonataPlayer.Effect`s). Then, after Open
// in Sonata, the same keys still drive Sonata's own player.
//
// The file must be a 4/4 MIDI file with no pickup (a bar is 4 beats, which is
// what the scrubber's aria-valuenow reports).
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/file-preview/e2e/keyboard-verify.ts \
//     [--file "~/Downloads/sunny-roberto-piano-notation-v2.mid"] [--out /tmp/midi-keys] [--headed]

import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const FILE = arg("file", "~/Downloads/sunny-roberto-piano-notation-v2.mid");
const OUT = arg("out", "/tmp/midi-keys");
const PREVIEW_PATH = `/files/at/${encodeURIComponent(
  FILE.slice(0, FILE.lastIndexOf("/")),
)}/${encodeURIComponent(FILE.slice(FILE.lastIndexOf("/") + 1))}`;
const SONG_URL = /\/sonata\/song\/[^/?#]+(?:\/\d+)?$/;
// The deferred plugin tier can take a while on a cold page.
const RENDER_TIMEOUT_MS = 45_000;

const r = report("midi file preview — keyboard transport");

/** Is the player playing? (The toggle is labelled with what a press does.) */
async function playing(page: Page): Promise<boolean> {
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  return (await pause.count()) > 0;
}

async function beat(page: Page): Promise<number> {
  const slider = page.getByRole("slider", { name: "Song position" }).first();
  return Number(await slider.getAttribute("aria-valuenow"));
}

/** Space toggles the player both ways; ←/→ then jump the paused playhead. */
async function checkKeys(page: Page, where: string) {
  // Keys go to the page, not to whatever control a previous click focused.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  const was = await playing(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  r.eq(`${where}: Space toggles play/pause`, await playing(page), !was);
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  r.eq(`${where}: Space toggles it back`, await playing(page), was);

  if (await playing(page)) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
  }
  r.eq(`${where}: paused before seeking`, await playing(page), false);

  const start = await beat(page);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const forward = await beat(page);
  r.ok(`${where}: → jumps forward`, forward > start, `${start} → ${forward}`);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  const back = await beat(page);
  r.ok(`${where}: ← jumps back`, back < forward, `${forward} → ${back}`);
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  await boot(page, pathUrl(PREVIEW_PATH), {
    marker: 'button:has-text("Open in Sonata")',
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  // The preview auto-plays once the song composes.
  await page
    .getByRole("button", { name: "Pause", exact: true })
    .waitFor({ timeout: RENDER_TIMEOUT_MS });
  // Let the playhead move off the lead-in so ← has room.
  await page.waitForTimeout(2500);
  await checkKeys(page, "preview");
  await snap(page, OUT, "preview");

  await page
    .getByRole("button", { name: "Open in Sonata", exact: true })
    .click();
  await page.waitForURL(SONG_URL, { timeout: 30_000 });
  await page
    .getByRole("slider", { name: "Song position" })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1000);
  // Move off the lead-in so ← has room.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  await checkKeys(page, "sonata");
  await snap(page, OUT, "sonata");
});

await r.finish();
