// Verifies the MIDI file preview's hand-off end to end: the preview renders for
// a host .mid file (no Code tab) and starts playing on its own, and "Open in
// Sonata" lands on /sonata/song/<id>/<bar> — the preview playhead's bar — with
// Sonata's playhead parked at that bar's start. A second press from a fresh
// preview, rewound to the start, lands on the SAME song id (the import is
// idempotent by content) with no bar, so the library gains no duplicate.
//
// The file must be a 4/4 MIDI file with no pickup (bar N starts at beat
// 4·(N−1), which is what the scrubber's aria-valuenow reports).
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/file-preview/e2e/open-in-sonata-verify.ts \
//     [--file "~/Downloads/sunny-roberto-piano-notation-v2.mid"] [--play-ms 3500] [--out /tmp/midi-open] [--headed]

import type { Page } from "playwright";
import {
  arg,
  boot,
  numArg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const FILE = arg("file", "~/Downloads/sunny-roberto-piano-notation-v2.mid");
const PLAY_MS = numArg("play-ms", 3500);
const OUT = arg("out", "/tmp/midi-open");
const PREVIEW_PATH = `/files/at/${encodeURIComponent(
  FILE.slice(0, FILE.lastIndexOf("/")),
)}/${encodeURIComponent(FILE.slice(FILE.lastIndexOf("/") + 1))}`;
const SONG_URL = /\/sonata\/song\/([^/?#]+)(?:\/(\d+))?$/;
// The deferred plugin tier can take a while on a cold page.
const RENDER_TIMEOUT_MS = 45_000;

const r = report("midi file preview — open in Sonata");

/**
 * Open the preview, let it auto-play, pause, park the playhead (mid-song, or at
 * the start), and press Open in Sonata.
 */
async function openFromPreview(
  page: Page,
  park: "mid" | "start",
): Promise<{ songId: string; bar: number | null; parkedBeat: number }> {
  await boot(page, pathUrl(PREVIEW_PATH), {
    marker: 'button:has-text("Open in Sonata")',
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  const slider = page.getByRole("slider", { name: "Song position" });
  const before = Number(await slider.getAttribute("aria-valuenow"));
  await page.waitForTimeout(PLAY_MS);
  const after = Number(await slider.getAttribute("aria-valuenow"));
  r.ok("the preview plays on open", after > before, `${before} → ${after}`);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // Park the playhead deterministically: a click on the scrubber.
  const box = await slider.boundingBox();
  if (!box) throw new Error("scrubber has no box");
  const x = park === "mid" ? box.x + box.width * 0.6 : box.x + 1;
  await page.mouse.click(x, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const parkedBeat = Number(await slider.getAttribute("aria-valuenow"));
  await snap(page, OUT, `preview-${park}`);
  await page
    .getByRole("button", { name: "Open in Sonata", exact: true })
    .click();
  await page.waitForURL(SONG_URL, { timeout: 30_000 });
  const m = SONG_URL.exec(new URL(page.url()).pathname);
  if (!m) throw new Error(`unexpected URL ${page.url()}`);
  return {
    songId: m[1]!,
    bar: m[2] !== undefined ? Number(m[2]) : null,
    parkedBeat,
  };
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  await boot(page, pathUrl(PREVIEW_PATH), {
    marker: 'button:has-text("Open in Sonata")',
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  r.eq(
    "no Code tab for a MIDI file",
    await page.getByRole("tab", { name: "Code" }).count(),
    0,
  );

  const first = await openFromPreview(page, "mid");
  r.note(
    `parked at beat ${first.parkedBeat}, landed on song ${first.songId} bar ${first.bar}`,
  );
  r.eq(
    "the URL carries the playhead's bar",
    first.bar,
    Math.floor(first.parkedBeat / 4) + 1,
  );

  const slider = page.getByRole("slider", { name: "Song position" });
  await slider.waitFor({ state: "visible", timeout: 30_000 });
  // The reset parks the cursor once the song composes; give it a frame or two.
  await page.waitForTimeout(1000);
  const now = await slider.getAttribute("aria-valuenow");
  r.eq(
    "Sonata's playhead is at the bar's start beat",
    now,
    String(((first.bar ?? 1) - 1) * 4),
  );
  await snap(page, OUT, "sonata");

  const second = await openFromPreview(page, "start");
  r.eq("a second open reuses the same song", second.songId, first.songId);
  r.eq("opening at the start carries no bar", second.bar, null);
});

await r.finish();
