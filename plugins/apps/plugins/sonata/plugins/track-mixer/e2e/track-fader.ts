// Verifies the Tracks panel's per-track fader:
//   - the fader is out of reach at rest, and hovering the track's speaker
//     reveals it with no click;
//   - moving it changes the level, and the level survives a reload — i.e. the
//     throttled write really reached the DB, not just the thumb;
//   - walking back up lands exactly on 100% (the unity detent);
//   - clicking the speaker still mutes: the hover disclosure never swallows the
//     press.
//
// The pointer is driven by coordinates, not by Playwright's `click()`. At rest
// the speaker lives inside a panel the disclosure marks `inert`, and it only
// becomes live because a real pointer ENTERS the always-live wrapper before it
// presses. `click()` would run its own actionability check against the inert
// element and either refuse or skip the hover — testing Playwright's gesture
// instead of a person's. Moving there and then pressing is the person's.
//
// Leaves the track as it found it (level and mute).
//
// Usage:
//   ./equin run plugins/apps/plugins/sonata/plugins/track-mixer/e2e/track-fader.ts \
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
  "usage: track-fader.ts --song <songId> [--url …] [--headed]",
);
const OUT = "/tmp/sonata-track-fader";

/** Keyboard steps to move the fader by: 10 × step 0.01 = 10 percentage points. */
const NUDGE = 10;

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  const r = report("sonata track fader");

  const speaker = page
    .getByRole("button", { name: /^(Mute|Unmute) track$/ })
    .first();
  const slider = page.getByRole("slider", { name: /^Volume for / }).first();

  const tracksHeader = page.getByRole("button", {
    name: "Tracks",
    exact: true,
  });

  /**
   * Open the song, and the Tracks card with it, then wait for the first
   * track's speaker. A collapsed section card does not mount its body at all,
   * so there is no speaker to find until it is open. Its open state lives in
   * this throwaway browser's localStorage, so expanding it leaves nothing
   * behind.
   */
  const openSong = async () => {
    await page.goto(pathUrl(`/sonata/song/${songId}`));
    // Longer than the default: the first open after a deploy cold-boots the
    // backend and loads the song's plugin chunks, which on a loaded host can
    // outlast 30s. It still fails if the card never renders — just later.
    await tracksHeader.waitFor({ timeout: 90_000 });
    if ((await tracksHeader.getAttribute("aria-expanded")) === "false") {
      await tracksHeader.click();
    }
    await speaker.waitFor({ state: "attached" });
  };

  /** Move the real pointer onto the speaker — the hover that opens the fader. */
  const pointAtSpeaker = async () => {
    const box = await speaker.boundingBox();
    if (!box) throw new Error("speaker has no box — is the Tracks panel open?");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // The disclosure's open transition is ~200ms; let it settle.
    await page.waitForTimeout(400);
  };

  /** Whether the fader sits inside a panel the disclosure has made inert. */
  const faderInert = () =>
    slider.evaluate((el) => el.closest("[inert]") !== null);

  const faderValue = async () => Number(await slider.inputValue());
  const isMuted = async () =>
    (await speaker.getAttribute("aria-pressed")) === "true";

  await openSong();
  const startValue = await faderValue();
  const startMuted = await isMuted();
  r.note(`start: level ${startValue}, muted ${startMuted}`);

  // ── Reveal ──────────────────────────────────────────────────────────────
  r.ok("fader is out of reach at rest", await faderInert());
  await snap(page, OUT, "1-rest");

  await pointAtSpeaker();
  r.ok("hovering the speaker reveals the fader", !(await faderInert()));
  await snap(page, OUT, "2-hover");

  // ── Move + persist ──────────────────────────────────────────────────────
  // Keyboard, not a drag: it lands on exact values, so the persisted number
  // can be compared for equality. Focus keeps the disclosure open while the
  // keys go in, the way it would for someone tabbing to the fader.
  await slider.focus();
  for (let i = 0; i < NUDGE; i++) await page.keyboard.press("ArrowLeft");
  const moved = await faderValue();
  r.ok(
    "the fader moved down",
    moved < startValue,
    `was ${startValue}, now ${moved}`,
  );
  await snap(page, OUT, "3-moved");

  // Past the throttle interval and a round trip, then reload: only a level the
  // server holds can survive this.
  await page.waitForTimeout(800);
  await openSong();
  await pointAtSpeaker();
  r.eq("the new level survives a reload", await faderValue(), moved);

  // ── Detent / restore ────────────────────────────────────────────────────
  await slider.focus();
  for (let i = 0; i < 300 && (await faderValue()) < startValue; i++) {
    await page.keyboard.press("ArrowRight");
  }
  const restored = await faderValue();
  r.eq("the fader walks back to where it started", restored, startValue);
  if (startValue === 1) {
    r.ok(
      "the unity detent lands exactly on 100%",
      restored === 1,
      `landed on ${restored}`,
    );
  }

  // ── Mute through the disclosure ─────────────────────────────────────────
  // Leave the fader and come back, so the press arrives the way a person's
  // does: pointer enters, disclosure opens, then the button goes down.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await pointAtSpeaker();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  r.eq("clicking the speaker toggles mute", await isMuted(), !startMuted);
  await snap(page, OUT, "4-muted");

  // Put mute back.
  await pointAtSpeaker();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  r.eq("a second click restores mute", await isMuted(), startMuted);

  await r.finish();
});
