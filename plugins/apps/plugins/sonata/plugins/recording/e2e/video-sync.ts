// Measures how closely Sonata's playhead follows the recording it is timed on
// (a UG song aligned to a YouTube video), then drives pause, ←/→ seeks, an A–B
// loop wrap and ↑/↓ tempo (the video's playbackRate must follow). The video
// lives in the player's Recording section (opened here if it is collapsed),
// with its volume row (mute, slider, level) below it; collapsing the section
// mid-play must leave the video playing, parked off screen, still driving the
// transport (see video-persistence.ts for display switches and the on/off
// switch).
//
// Drift is measured at every cursor PAINT, not by polling: a MutationObserver
// on the scrubber fill fires in the same task as the paint, and reads the
// YouTube player's getCurrentTime() (the IFrame API's own player object, via
// YT.get) right there. drift = beatToSeconds(alignedScore, beat) − video time,
// negative when the cursor trails. Polling instead would mostly measure the
// page's frame period: a headless browser animates this page at a few frames
// a second. The API time itself is checked against the <video> element's
// currentTime inside the iframe (the ground truth) at the start.
//
// The cursor's beat is the fill's scaleX × the slider's aria-valuemax (the
// aria-valuenow is rounded). Sound cannot be judged from here: this reports
// the objective drift only.
//
// A refusal the player reports is swallowed (never reaches the server, where
// it would mark the song's video unplayable and re-pick) and fails the run.
//
// Usage:
//   ./singularity run plugins/apps/plugins/sonata/plugins/recording/e2e/video-sync.ts \
//     --song <songId> [--seconds 20] [--settle 2000] [--out /tmp/video-sync] [--headed]

import type { Frame, Page } from "playwright";
import {
  agentFetch,
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  alignedScore,
  AlignmentRecordSchema,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import {
  parseUgTab,
  UgTabSchema,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { beatToSeconds } from "@plugins/apps/plugins/sonata/plugins/score/core";

const songId = requireArg(
  "song",
  "usage: video-sync.ts --song <songId> [--seconds 20] [--out …] [--headed]",
);
const SECONDS = numArg("seconds", 20);
const OUT = arg("out", "/tmp/video-sync");
const RENDER_TIMEOUT_MS = 90_000;

const r = report(`sonata recording sync — ${songId}`);

// ── The Score the player compiles: alignedScore over the stored record ───────
async function getJson(path: string): Promise<unknown> {
  const res = await agentFetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
const tab = UgTabSchema.nullable().parse(
  await getJson(`/api/sonata/songs/${songId}/ultimate-guitar`),
);
if (tab === null) throw new Error(`song ${songId} has no UG tab`);
const row = (await getJson(
  `/api/sonata/songs/${songId}/ultimate-guitar/alignment`,
)) as { videoId: string | null; record: unknown } | null;
if (row?.record == null || row.videoId == null)
  throw new Error(`song ${songId} has no alignment record`);
const record = AlignmentRecordSchema.parse(row.record);
const score = alignedScore(parseUgTab(tab), record, tab.songName);
console.log(
  `video ${record.videoId} · score ${record.score.toFixed(3)} · transpose ${record.transpose}`,
);

// ── The page-side recorder ───────────────────────────────────────────────────
type Paint = { at: number; beat: number; video: number; state: number };

/** Installs the per-paint recorder (idempotent); paints accumulate in the page. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __paints?: Paint[];
      YT: {
        get(id: string): { getCurrentTime(): number; getPlayerState(): number };
      };
    };
    if (w.__paints) return;
    const paints: Paint[] = [];
    w.__paints = paints;
    const slider = document.querySelector(
      '[role="slider"][aria-label="Song position"]',
    );
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src^="https://www.youtube.com/embed"]',
    );
    if (!slider || !iframe) throw new Error("no slider or no YouTube iframe");
    const fill = [...slider.querySelectorAll<HTMLElement>("*")].find((e) =>
      e.style.transform.startsWith("scaleX("),
    );
    if (!fill) throw new Error("no scrubber fill");
    const player = w.YT.get(iframe.id);
    new MutationObserver(() => {
      const fraction = Number(
        /scaleX\(([^)]+)\)/.exec(fill.style.transform)?.[1],
      );
      paints.push({
        at: performance.now(),
        beat: fraction * Number(slider.getAttribute("aria-valuemax")),
        video: player.getCurrentTime(),
        state: player.getPlayerState(),
      });
    }).observe(fill, { attributes: true, attributeFilter: ["style"] });
  });
}

/** The paints recorded since the last drain. */
async function drain(page: Page): Promise<Paint[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __paints: Paint[] };
    return w.__paints.splice(0);
  });
}

const PLAYING = 1;

type Drift = {
  at: number;
  videoSec: number;
  cursorSec: number;
  driftMs: number;
};

/** Drift at each paint while the video plays (YT state 1). */
function drifts(paints: Paint[]): Drift[] {
  return paints
    .filter((p) => p.state === PLAYING)
    .map((p) => {
      const cursorSec = beatToSeconds(score, p.beat);
      return {
        at: p.at,
        videoSec: p.video,
        cursorSec,
        driftMs: (cursorSec - p.video) * 1000,
      };
    });
}

function stats(ds: Drift[]) {
  const abs = ds.map((d) => Math.abs(d.driftMs)).sort((a, b) => a - b);
  const signed = ds.map((d) => d.driftMs).sort((a, b) => a - b);
  const q = (xs: number[], p: number) =>
    xs.length === 0
      ? NaN
      : xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  const span = ds.length > 1 ? (ds.at(-1)!.at - ds[0]!.at) / 1000 : 0;
  return {
    paints: ds.length,
    paintsPerSec: span > 0 ? Math.round(ds.length / span) : 0,
    medianAbsMs: Math.round(q(abs, 0.5)),
    p95AbsMs: Math.round(q(abs, 0.95)),
    maxAbsMs: Math.round(abs.at(-1) ?? NaN),
    medianSignedMs: Math.round(q(signed, 0.5)),
  };
}
type Stats = ReturnType<typeof stats>;

const log = (label: string, s: Stats) =>
  console.log(
    `${label}: ${s.paints} paints (${s.paintsPerSec}/s) · |drift| median ${s.medianAbsMs} ms, p95 ${s.p95AbsMs} ms, max ${s.maxAbsMs} ms · signed median ${s.medianSignedMs} ms`,
  );

/** Gaps where the video stopped advancing while it was supposed to play. */
function stops(ds: Drift[]): number {
  let n = 0;
  for (let i = 1; i < ds.length; i++) {
    const dt = (ds[i]!.at - ds[i - 1]!.at) / 1000;
    if (dt > 0.05 && ds[i]!.videoSec - ds[i - 1]!.videoSec < dt * 0.2) n++;
  }
  return n;
}

type VideoRead = { t: number; paused: boolean; rate: number };
async function videoRead(frame: Frame): Promise<VideoRead> {
  return frame.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) throw new Error("no <video> in the YouTube frame");
    return { t: v.currentTime, paused: v.paused, rate: v.playbackRate };
  });
}

/** The API's time vs the <video> element's, read back to back (ms). */
async function apiVsElement(page: Page, frame: Frame): Promise<number> {
  const api = await page.evaluate(() => {
    const w = window as unknown as {
      YT: { get(id: string): { getCurrentTime(): number } };
    };
    const f = document.querySelector<HTMLIFrameElement>(
      'iframe[src^="https://www.youtube.com/embed"]',
    )!;
    return {
      t: w.YT.get(f.id).getCurrentTime(),
      at: performance.timeOrigin + performance.now(),
    };
  });
  const el = await frame.evaluate(() => ({
    t: document.querySelector("video")!.currentTime,
    at: performance.timeOrigin + performance.now(),
  }));
  return (api.t - (el.t - (el.at - api.at) / 1000)) * 1000;
}

async function press(page: Page, key: string) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press(key);
}

async function cursorSec(page: Page): Promise<number> {
  const beat = await page.evaluate(() => {
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
  return beatToSeconds(score, beat);
}

// ── The run ──────────────────────────────────────────────────────────────────
const results: Record<string, unknown> = {
  song: songId,
  video: record.videoId,
};

await withBrowser(async (h) => {
  const { page } = await h.session({
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  const refusals: string[] = [];
  await page.route(
    "**/ultimate-guitar/alignment/video-refused",
    async (route) => {
      refusals.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    },
  );
  await page.goto(pathUrl(`/sonata/song/${songId}`));
  await page
    .getByRole("slider", { name: "Song position" })
    .waitFor({ timeout: RENDER_TIMEOUT_MS });

  // The video is the Recording section's: open it when it is collapsed (its
  // open state is per device, and a fresh browser profile seeds it open only
  // for a song that plays on a video).
  const recordingHeader = page.getByRole("button", { name: /^Recording/ });
  const videoSlider = page.getByRole("slider", { name: "Video volume" });
  await recordingHeader.waitFor({ timeout: RENDER_TIMEOUT_MS });
  if (!(await videoSlider.isVisible())) await recordingHeader.click();
  await videoSlider.waitFor({ timeout: 10_000 });
  r.eq(
    "the Recording section shows no sync offset (it is a Settings → Config field)",
    await page.getByRole("slider", { name: "Sync offset" }).count(),
    0,
  );
  r.eq(
    'a synced video wears no "Not synced" badge',
    await page.getByText("Not synced", { exact: true }).count(),
    0,
  );

  let frame: Frame | undefined;
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline && refusals.length === 0) {
    frame = page
      .frames()
      .find((f) => f.url().startsWith("https://www.youtube.com/embed"));
    if (frame && (await frame.$("video"))) break;
    await page.waitForTimeout(500);
  }
  r.eq("the player reports no refusal", refusals, []);
  r.ok(
    "the video panel embeds the recording",
    frame !== undefined,
    record.videoId,
  );
  if (!frame || refusals.length > 0) return;
  // How long the song may settle before the first play. A play pressed in the
  // first seconds after a cold load is sometimes stopped again by the session
  // ~0.3 s later (see the plan doc's Results); the default stays short so the
  // run keeps showing it.
  await page.waitForTimeout(numArg("settle", 2000));
  await installRecorder(page);
  await snap(page, OUT, "1-before-play");

  // ── Play, after a tempo ↑ asked before the video ever played ──
  // (the player lists no rates yet: the request is held until it plays)
  await press(page, "ArrowUp");
  await page.waitForTimeout(500);
  await press(page, "Space");
  await page.waitForTimeout(3000);
  const started = await videoRead(frame);
  r.ok("Space starts the video", !started.paused);
  r.eq(
    "a tempo ↑ before the first play applies once it plays",
    started.rate,
    1.25,
  );
  await press(page, "ArrowDown");
  await page.waitForTimeout(1200);
  r.eq("tempo ↓ back to 1", (await videoRead(frame)).rate, 1);
  const apiErr: number[] = [];
  for (let i = 0; i < 5; i++)
    apiErr.push(Math.round(await apiVsElement(page, frame)));
  console.log(`YT API time − <video>.currentTime: ${apiErr.join(", ")} ms`);
  results.apiVsElementMs = apiErr;
  await drain(page);
  await page.waitForTimeout(SECONDS * 1000);
  const play = drifts(await drain(page));
  const playStats = stats(play);
  log("play", playStats);
  results.play = playStats;
  r.ok(
    "play: median |drift| ≤ 40 ms",
    playStats.medianAbsMs <= 40,
    `${playStats.medianAbsMs} ms`,
  );
  r.ok(
    "play: max |drift| < 150 ms",
    playStats.maxAbsMs < 150,
    `${playStats.maxAbsMs} ms`,
  );
  r.eq("play: the video never stops", stops(play), 0);
  await snap(page, OUT, "2-playing");

  // ── Pause ──
  await press(page, "Space");
  await page.waitForTimeout(1000);
  const a = { v: await videoRead(frame), c: await cursorSec(page) };
  await page.waitForTimeout(1000);
  const b = { v: await videoRead(frame), c: await cursorSec(page) };
  r.ok("pause: the video pauses", a.v.paused && b.v.paused);
  r.ok(
    "pause: cursor and video both hold",
    Math.abs(b.c - a.c) < 0.005 && Math.abs(b.v.t - a.v.t) < 0.005,
    `cursor ${a.c.toFixed(3)}→${b.c.toFixed(3)}, video ${a.v.t.toFixed(3)}→${b.v.t.toFixed(3)}`,
  );
  const pausedDriftMs = Math.round((b.c - b.v.t) * 1000);
  console.log(`paused: cursor − video = ${pausedDriftMs} ms`);
  results.pausedDriftMs = pausedDriftMs;

  // ── → while paused ──
  await press(page, "ArrowRight");
  await page.waitForTimeout(1500);
  const s = { v: await videoRead(frame), c: await cursorSec(page) };
  r.ok(
    "→ (paused): the cursor jumps forward",
    s.c > b.c + 0.5,
    `${b.c.toFixed(2)}→${s.c.toFixed(2)}`,
  );
  r.ok(
    "→ (paused): the video follows and stays paused",
    s.v.paused && Math.abs(s.c - s.v.t) < 0.1,
    `cursor − video ${Math.round((s.c - s.v.t) * 1000)} ms, paused=${s.v.paused}`,
  );
  results.seekPausedDriftMs = Math.round((s.c - s.v.t) * 1000);

  // ── ← then → while playing ──
  await press(page, "Space");
  await page.waitForTimeout(2500);
  await drain(page);
  await press(page, "ArrowLeft");
  await page.waitForTimeout(1000);
  await drain(page); // the seek itself
  await page.waitForTimeout(3000);
  const back = drifts(await drain(page));
  await press(page, "ArrowRight");
  await page.waitForTimeout(1000);
  await drain(page);
  await page.waitForTimeout(3000);
  const fwd = drifts(await drain(page));
  const seekStats = stats([...back, ...fwd]);
  log("after ← / → while playing (1 s settle)", seekStats);
  results.seeks = seekStats;
  r.ok(
    "seeks: median |drift| ≤ 40 ms after 1 s",
    seekStats.medianAbsMs <= 40,
    `${seekStats.medianAbsMs} ms`,
  );
  r.eq("seeks: the video never stops", stops(back) + stops(fwd), 0);

  // ── A–B loop: one tap loops the section at the playhead; play through a wrap ──
  await press(page, "l");
  await page.waitForTimeout(500);
  await drain(page);
  let wrapAt: number | null = null;
  const loopPaints: Paint[] = [];
  const loopDeadline = Date.now() + 75_000;
  while (Date.now() < loopDeadline && wrapAt === null) {
    await page.waitForTimeout(500);
    for (const p of await drain(page)) {
      const prev = loopPaints.at(-1);
      if (wrapAt === null && prev && p.beat < prev.beat - 2) wrapAt = p.at;
      loopPaints.push(p);
    }
  }
  r.ok("loop: the playhead wraps from B back to A", wrapAt !== null);
  await page.waitForTimeout(4000);
  const afterWrap = drifts([...loopPaints, ...(await drain(page))]).filter(
    (d) => wrapAt !== null && d.at > wrapAt + 1000,
  );
  const wrapStats = stats(afterWrap);
  log("after the loop wrap (1 s settle)", wrapStats);
  results.loopWrap = wrapStats;
  r.ok(
    "loop: the video wrapped with it (median ≤ 40 ms)",
    wrapStats.medianAbsMs <= 40,
    `${wrapStats.medianAbsMs} ms`,
  );
  r.eq(
    "loop: still playing after the wrap",
    (await videoRead(frame)).paused,
    false,
  );
  await snap(page, OUT, "3-loop");
  await press(page, "l"); // loop off

  // ── Tempo ↑ ↑ then ↓ ↓ ──
  const rates: number[] = [];
  for (const key of ["ArrowUp", "ArrowUp"]) {
    await press(page, key);
    await page.waitForTimeout(1200);
    rates.push((await videoRead(frame)).rate);
  }
  await drain(page);
  await page.waitForTimeout(5000);
  const fast = drifts(await drain(page));
  const fastStats = stats(fast);
  log(`at video rate ${rates.at(-1)}`, fastStats);
  for (const key of ["ArrowDown", "ArrowDown"]) {
    await press(page, key);
    await page.waitForTimeout(1200);
    rates.push((await videoRead(frame)).rate);
  }
  console.log(`video playbackRate after ↑ ↑ ↓ ↓: ${rates.join(", ")}`);
  results.rates = rates;
  results.fast = fastStats;
  r.ok("tempo ↑ ↑: the video speeds up", rates[1]! > 1, rates.join(", "));
  r.eq("tempo ↓ ↓: back to 1", rates[3], 1);
  r.ok(
    "tempo: the cursor follows the faster video (median ≤ 40 ms)",
    fastStats.medianAbsMs <= 40,
    `${fastStats.medianAbsMs} ms`,
  );
  r.eq("tempo: the video never stops", stops(fast), 0);

  // ── The Recording section: video, then its volume row ──
  await snap(page, OUT, "4-recording-section");

  // ── Collapse the section mid-play: the video plays on, still driving ──
  // (the player is the session's; the section was only its viewport)
  await recordingHeader.click();
  await page.waitForTimeout(500);
  r.eq(
    "collapsed: the video is still embedded (parked off screen)",
    await page.locator('iframe[src^="https://www.youtube.com/embed"]').count(),
    1,
  );
  await drain(page);
  await page.waitForTimeout(3000);
  const collapsed = drifts(await drain(page));
  const collapsedStats = stats(collapsed);
  log("collapsed", collapsedStats);
  results.collapsed = collapsedStats;
  r.ok(
    "collapsed mid-play: the transport still follows the video (median ≤ 40 ms)",
    collapsed.length > 0 && collapsedStats.medianAbsMs <= 40,
    `${collapsed.length} paints, ${collapsedStats.medianAbsMs} ms`,
  );
  r.eq("collapsed: the video never stops", stops(collapsed), 0);
  await press(page, "Space");
  await page.waitForTimeout(500);
  const stoppedAt = await cursorSec(page);
  await page.waitForTimeout(1000);
  r.ok(
    "collapsed: Space still pauses, the video too (nothing stuck)",
    Math.abs((await cursorSec(page)) - stoppedAt) < 0.005 &&
      (await videoRead(frame)).paused,
  );
  await recordingHeader.click();
  await videoSlider.waitFor({ timeout: 10_000 });
  r.eq("no refusal reported during the run", refusals, []);
});

console.log(JSON.stringify(results));
await r.finish();
