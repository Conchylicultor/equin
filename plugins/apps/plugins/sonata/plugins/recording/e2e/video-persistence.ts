// The recording's video outlives what shows it: plays a UG song aligned to a
// YouTube video, then switches the display lens, collapses and reopens the
// Recording section, and turns the video off and on with the section header's
// switch — checking after each step that the transport still plays, that the
// video plays with it (same iframe, never reloaded, never paused), and that the
// two stay in step.
//
// "Same iframe" is checked by a marker property set on the iframe element: a
// re-created player is a new element without it.
//
// Usage:
//   ./singularity run plugins/apps/plugins/sonata/plugins/recording/e2e/video-persistence.ts \
//     --song <songId> [--out /tmp/video-persistence] [--headed]

import type { Frame, Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const songId = requireArg(
  "song",
  "usage: video-persistence.ts --song <songId> [--out …] [--headed]",
);
const OUT = arg("out", "/tmp/video-persistence");
const RENDER_TIMEOUT_MS = 90_000;
const IFRAME = 'iframe[src^="https://www.youtube.com/embed"]';

const r = report(`sonata recording persistence — ${songId}`);

/** The scrubber's position in beats (fill scaleX × aria-valuemax). */
async function cursorBeat(page: Page): Promise<number> {
  return page.evaluate(() => {
    const slider = document.querySelector(
      '[role="slider"][aria-label="Song position"]',
    )!;
    const fill = [...slider.querySelectorAll<HTMLElement>("*")].find((e) =>
      e.style.transform.startsWith("scaleX("),
    )!;
    const fraction = Number(
      /scaleX\(([^)]+)\)/.exec(fill.style.transform)?.[1],
    );
    return fraction * Number(slider.getAttribute("aria-valuemax"));
  });
}

async function youtubeFrame(page: Page): Promise<Frame | undefined> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((f) => f.url().startsWith("https://www.youtube.com/embed"));
    if (frame && !frame.isDetached() && (await frame.$("video"))) return frame;
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function videoTime(
  frame: Frame,
): Promise<{ t: number; paused: boolean }> {
  return frame.evaluate(() => {
    const v = document.querySelector("video")!;
    return { t: v.currentTime, paused: v.paused };
  });
}

async function markIframe(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const f = document.querySelector(sel) as unknown as { __mark?: true };
    f.__mark = true;
  }, IFRAME);
}

async function sameIframe(page: Page): Promise<boolean> {
  return page.evaluate((sel) => {
    const f = document.querySelector(sel) as unknown as {
      __mark?: true;
    } | null;
    return f?.__mark === true;
  }, IFRAME);
}

async function press(page: Page, key: string) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press(key);
}

/** Over `ms`, did the cursor and the video both advance (by ≥ half of it)? */
async function bothAdvance(
  page: Page,
  frame: Frame,
  ms: number,
): Promise<{ cursor: boolean; video: boolean; detail: string }> {
  const c0 = await cursorBeat(page);
  const v0 = await videoTime(frame);
  await page.waitForTimeout(ms);
  const c1 = await cursorBeat(page);
  const v1 = await videoTime(frame);
  return {
    cursor: c1 > c0 + 0.5,
    video: !v1.paused && v1.t > v0.t + ms / 2000,
    detail: `cursor ${c0.toFixed(2)}→${c1.toFixed(2)} beats, video ${v0.t.toFixed(2)}→${v1.t.toFixed(2)} s (paused=${v1.paused})`,
  };
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  // Never let a refusal reach the server (it would re-pick the song's video).
  await page.route("**/ultimate-guitar/alignment/video-refused", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto(pathUrl(`/sonata/song/${songId}`));
  await page
    .getByRole("slider", { name: "Song position" })
    .waitFor({ timeout: RENDER_TIMEOUT_MS });

  const recordingHeader = page.getByRole("button", { name: /^Recording/ });
  const videoSlider = page.getByRole("slider", { name: "Video volume" });
  await recordingHeader.waitFor({ timeout: RENDER_TIMEOUT_MS });
  if (!(await videoSlider.isVisible())) await recordingHeader.click();
  await videoSlider.waitFor({ timeout: 10_000 });

  let frame = await youtubeFrame(page);
  r.ok("the video panel embeds the recording", frame !== undefined);
  if (!frame) return;
  await page.waitForTimeout(2000);
  await markIframe(page);

  await press(page, "Space");
  await page.waitForTimeout(3000);
  let step = await bothAdvance(page, frame, 2000);
  r.ok(
    "playing: cursor and video advance",
    step.cursor && step.video,
    step.detail,
  );

  // ── Switch the display lens ──
  const displays = page
    .getByRole("radiogroup", { name: "Display" })
    .getByRole("radio");
  const count = await displays.count();
  r.ok("there are display lenses to switch between", count > 1, `${count}`);
  for (let i = 0; i < count; i++) {
    const lens = displays.nth(i);
    if ((await lens.getAttribute("aria-checked")) === "true") continue;
    const name =
      (await lens.getAttribute("aria-label")) ??
      (await lens.getAttribute("title")) ??
      `#${i}`;
    await lens.click();
    await page.waitForTimeout(1500);
    step = await bothAdvance(page, frame, 2000);
    r.ok(
      `switch to ${name}: still playing, video too`,
      step.cursor && step.video,
      step.detail,
    );
    r.ok(
      `switch to ${name}: the same iframe (not reloaded)`,
      await sameIframe(page),
    );
  }
  await snap(page, OUT, "1-after-switches");

  // ── Collapse the Recording section ──
  await recordingHeader.click();
  await page.waitForTimeout(1500);
  r.eq("collapsed: the volume row is gone", await videoSlider.count(), 0);
  step = await bothAdvance(page, frame, 2000);
  r.ok(
    "collapsed: the video keeps playing with the transport",
    step.cursor && step.video,
    step.detail,
  );
  r.ok("collapsed: the same iframe", await sameIframe(page));
  await snap(page, OUT, "2-collapsed");

  // ── Reopen ──
  await recordingHeader.click();
  await videoSlider.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  r.ok("reopened: the same iframe", await sameIframe(page));
  r.eq(
    "reopened: no player error",
    await page.getByText(/The video player failed/).count(),
    0,
  );
  step = await bothAdvance(page, frame, 2000);
  r.ok(
    "reopened: still playing, video too",
    step.cursor && step.video,
    step.detail,
  );
  await snap(page, OUT, "3-reopened");

  // ── The header switch: video off, then on ──
  const toggle = page.getByRole("switch", { name: /recording video/i });
  r.ok("the Recording header has a video switch", (await toggle.count()) === 1);
  if ((await toggle.count()) !== 1) return;
  await toggle.click();
  await page.waitForTimeout(1500);
  r.eq("off: the video is gone", await page.locator(IFRAME).count(), 0);
  const c0 = await cursorBeat(page);
  await page.waitForTimeout(2000);
  const c1 = await cursorBeat(page);
  r.ok(
    "off: the synth plays on",
    c1 > c0 + 0.5,
    `${c0.toFixed(2)}→${c1.toFixed(2)}`,
  );
  await snap(page, OUT, "4-off");

  await toggle.click();
  frame = await youtubeFrame(page);
  r.ok("on: the video is back", frame !== undefined);
  if (!frame) return;
  await page.waitForTimeout(4000);
  step = await bothAdvance(page, frame, 2000);
  r.ok(
    "on: the video plays with the transport",
    step.cursor && step.video,
    step.detail,
  );
  await snap(page, OUT, "5-on");
  await press(page, "Space");
});

await r.finish();
