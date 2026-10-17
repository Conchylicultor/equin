// Verifies Sonata's per-song settings across song switches — the "pending is a
// state" design of the shell's per-song settings (one loaded song: its id, its
// content and its settings in one state):
//   - on song A, a transpose offset, a chord mode and a muted track are set and
//     survive a reload (they persisted, not just the optimistic store);
//   - switching to song B and back IN THE APP (Back to Library, then the song's card)
//     leaks nothing: B shows its own settings, and back on A every setting is
//     A's again;
//   - no frame in between shows a default or the other song's value. A rAF
//     sampler records, on every animation frame, the transpose readout, the
//     chord-mode chip, the first track's mute button and whether a display shows
//     its empty-score message. While a song's settings load those controls are
//     loading placeholders (absent from the sample), so every PRESENT value
//     sampled on a song's route must be that song's own;
//   - the same holds when the song switched away from is PLAYING IN THE
//     BACKGROUND: A is played from its library card (in place, so it is the
//     open song with no player on screen), then B's card is opened — B's player
//     loads B while A is still the open song, the window where A's settings once
//     leaked onto B for a frame. Every frame on B's route shows B's own settings,
//     and B opens stopped (A's playback does not play on over it). Then the
//     reverse: B in the background, A's card opened.
//
// Both songs need notes (the Tracks card is how the script knows a song's
// settings have settled); a MIDI song A is best, its Tracks card listing the
// original tracks first. Song B must differ from A. Chord mode is set
// through the API (the flag alone — the Chords chip's own toggle also rewrites
// the mixer, which this script would then have to undo track by track).
//
// Restores everything it changed on A (transpose, chord mode, and the song's
// track-view rows exactly as they were) in a finally; B is only read.
//
// Width-independent: the player header is an adaptive bar, which relocates
// what does not fit (a header control at the harness's default 1400 px,
// the transport or Back to Library on a narrower one) into its `⋯` panel. A header
// control is clicked through `reachInBar` — in the row, or by opening the `⋯`
// holding it, as a person would — and read through CSS locators, which still
// find a relocated control in the closed (display: none, aria-hidden) panel
// where a role locator does not.
//
// Usage:
//   ./singularity run plugins/apps/plugins/sonata/e2e/song-switch.ts \
//     --song-a <songId> --song-b <songId> [--url http://<namespace>.localhost:9000] [--headed]

import type { TrackViewRow } from "@plugins/apps/plugins/sonata/plugins/track-mixer/core";
import { reachInBar } from "@plugins/primitives/plugins/adaptive-bar/e2e";
import {
  onBeforeFinish,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "usage: song-switch.ts --song-a <songId> --song-b <songId> [--url …] [--headed]";
const songA = requireArg("song-a", USAGE);
const songB = requireArg("song-b", USAGE);
if (songA === songB) throw new Error("--song-a and --song-b must differ");
const OUT = "/tmp/sonata-song-switch";

/** One animation frame's view of the per-song settings (null ⇒ not rendered). */
interface Sample {
  path: string;
  /** The transpose trigger's `data-transpose-offset`, e.g. "2" — absent while pending. */
  transpose: string | null;
  /** The Chords card's chip — absent while pending or when the card is not offered. */
  chord: "on" | "off" | null;
  /** The first track's mute button `aria-pressed` — absent while pending / collapsed. */
  muted: string | null;
  /** A display is showing its empty-score message. */
  noNotes: boolean;
}

/** What a song's settled view shows. */
interface SongView {
  transpose: number;
  chord: "on" | "off";
  firstTrackMuted: boolean;
}

/**
 * The transpose trigger's offset (`data-transpose-offset`, the number its
 * badge shows) — present only once the offset is settled, so it reads the
 * offset without opening the popover. A CSS selector on purpose: the trigger
 * may sit in the header's closed overflow panel, where it is still rendered
 * but a role locator does not see it.
 */
const READOUT = "[data-transpose-offset]";
const READOUT_ATTR = "data-transpose-offset";
const CHORD_ON_TITLE = "Playing the detected chords";
const CHORD_OFF_TITLE = "Play the detected chords";

/** Parse the transpose trigger's offset attribute ("0", "2", "-3") into semitones. */
function parseTranspose(text: string): number {
  const n = Number(text);
  if (text.trim() === "" || !Number.isInteger(n)) {
    throw new Error(`unreadable transpose offset: "${text}"`);
  }
  return n;
}

const songPath = (songId: string) => `/sonata/song/${songId}`;

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  const r = report("sonata song switch");

  const readout = page.locator(READOUT);
  const tracksHeader = page.getByRole("button", {
    name: "Tracks",
    exact: true,
  });
  const speaker = page
    .getByRole("button", { name: /^(Mute|Unmute) track$/ })
    .first();

  // ── App API (through the browser context, so the writes carry its provenance)
  const api = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    data?: unknown,
  ): Promise<unknown> => {
    const res = await page.request.fetch(pathUrl(path), {
      method,
      ...(data === undefined ? {} : { data }),
    });
    if (!res.ok()) {
      throw new Error(
        `${method} ${path} — HTTP ${res.status()}: ${await res.text()}`,
      );
    }
    return res.status() === 204 ? undefined : await res.json();
  };
  const readTrackViews = async (songId: string): Promise<TrackViewRow[]> => {
    const body = (await api(
      "GET",
      `/api/resources/sonata-track-view?songId=${encodeURIComponent(songId)}`,
    )) as { value: TrackViewRow[] };
    return body.value;
  };

  // ── Page helpers ────────────────────────────────────────────────────────
  /**
   * Wait until the open song's settings have all settled: the transpose
   * trigger's offset (absent while pending) and the Tracks card (offered only
   * once the score is shown) are both there, and the card is expanded so the
   * mute buttons are mounted. Its open state lives in this throwaway browser's
   * localStorage.
   */
  const waitSettled = async () => {
    // Long: the first open after a deploy cold-boots the backend and loads the
    // song's plugin chunks. It still fails if the player never settles.
    await readout.waitFor({ state: "attached", timeout: 90_000 });
    await tracksHeader.waitFor({ timeout: 90_000 });
    if ((await tracksHeader.getAttribute("aria-expanded")) === "false") {
      await tracksHeader.click();
    }
    await speaker.waitFor({ state: "attached" });
  };

  const readView = async (): Promise<SongView> => {
    const text = await readout.getAttribute(READOUT_ATTR);
    if (text === null) throw new Error("transpose trigger has no offset");
    const on = await page.locator(`[data-tooltip^="${CHORD_ON_TITLE}"]`).count();
    return {
      transpose: parseTranspose(text),
      // No chip at all = the card is not offered: no detected chords and the
      // mode off (the card shows whenever the mode is on).
      chord: on > 0 ? "on" : "off",
      firstTrackMuted: (await speaker.getAttribute("aria-pressed")) === "true",
    };
  };

  const openFresh = async (songId: string): Promise<SongView> => {
    await page.goto(pathUrl(songPath(songId)));
    await waitSettled();
    return readView();
  };

  /** Open a song from the library the way a person does: click its card. */
  const openCard = async (songId: string, title: string) => {
    await page.getByText(title, { exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === songPath(songId), {
      timeout: 30_000,
    });
    await waitSettled();
  };

  /** Back to Library, in the header's row or its `⋯` panel. */
  const backToLibrary = () =>
    reachInBar(
      page,
      page.getByRole("button", { name: "Back to Library" }),
      (b) => b.click(),
    );

  /** Switch songs the way a person does: Back to Library, then the song's card. */
  const switchInApp = async (songId: string, title: string) => {
    await backToLibrary();
    await openCard(songId, title);
  };

  /**
   * The library card's (or table row's) own Play / Pause toggle for `title`:
   * the nearest ancestor of the title that holds one.
   */
  const cardToggle = (title: string, name: "Play" | "Pause") =>
    page
      .getByText(title, { exact: true })
      .first()
      .locator(
        "xpath=ancestor::*[.//button[@aria-label='Play' or @aria-label='Pause']][1]",
      )
      .getByRole("button", { name, exact: true });

  /**
   * From a song's player: back to the library, and play `title` in the
   * background from its card — in place, no navigation. Waits until it plays
   * (its toggle reads Pause), i.e. its settings settled and play-on-load ran.
   */
  const playInBackground = async (title: string) => {
    await backToLibrary();
    await cardToggle(title, "Play").click();
    await cardToggle(title, "Pause").waitFor({ timeout: 30_000 });
  };

  /**
   * The player's transport is stopped: its toggle reads Play, and no Pause is
   * rendered. By label, not role: the toggle sits in the transport strip
   * below the header.
   */
  const transportStopped = async () =>
    (await page.locator('button[aria-label="Play"]').count()) > 0 &&
    (await page.locator('button[aria-label="Pause"]').count()) === 0;

  /** Move the real pointer onto the first speaker and press it (see track-fader.ts). */
  const pressFirstSpeaker = async () => {
    const box = await speaker.boundingBox();
    if (!box) throw new Error("speaker has no box — is the Tracks card open?");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.move(0, 0);
  };

  /** Start recording one sample per animation frame, in the page. */
  const startSampling = () =>
    page.evaluate(
      ({ readoutSel, readoutAttr, onTitle, offTitle }) => {
        const w = window as unknown as {
          __songSamples: unknown[];
          __songSampling: boolean;
        };
        w.__songSamples = [];
        w.__songSampling = true;
        const tick = () => {
          if (!w.__songSampling) return;
          const readoutEl = document.querySelector(readoutSel);
          const speakerEl = document.querySelector(
            'button[aria-label="Mute track"], button[aria-label="Unmute track"]',
          );
          const chord = document.querySelector(`[data-tooltip^="${onTitle}"]`)
            ? "on"
            : document.querySelector(`[data-tooltip^="${offTitle}"]`)
              ? "off"
              : null;
          w.__songSamples.push({
            path: location.pathname,
            transpose: readoutEl?.getAttribute(readoutAttr) ?? null,
            chord,
            muted: speakerEl?.getAttribute("aria-pressed") ?? null,
            noNotes:
              document.body.textContent?.includes("No notes to display") ??
              false,
          });
          requestAnimationFrame(tick);
        };
        tick();
      },
      {
        readoutSel: READOUT,
        readoutAttr: READOUT_ATTR,
        onTitle: CHORD_ON_TITLE,
        offTitle: CHORD_OFF_TITLE,
      },
    );
  const stopSampling = async (): Promise<Sample[]> =>
    (await page.evaluate(() => {
      const w = window as unknown as {
        __songSamples: unknown[];
        __songSampling: boolean;
      };
      w.__songSampling = false;
      return w.__songSamples;
    })) as Sample[];

  /** Every sampled value present on `songId`'s route is `view`'s. */
  const checkFrames = (
    label: string,
    samples: Sample[],
    songId: string,
    view: SongView,
  ) => {
    const onRoute = samples.filter((s) => s.path === songPath(songId));
    r.ok(`${label}: frames were sampled on the route`, onRoute.length > 0);
    const badTranspose = onRoute.filter(
      (s) =>
        s.transpose !== null && parseTranspose(s.transpose) !== view.transpose,
    );
    r.ok(
      `${label}: no frame shows another transpose than ${view.transpose}`,
      badTranspose.length === 0,
      `saw ${[...new Set(badTranspose.map((s) => s.transpose))].join(", ")}`,
    );
    const badChord = onRoute.filter(
      (s) => s.chord !== null && s.chord !== view.chord,
    );
    r.ok(
      `${label}: no frame shows chord mode ${view.chord === "on" ? "off" : "on"}`,
      badChord.length === 0,
      `${badChord.length} frame(s)`,
    );
    const muted = String(view.firstTrackMuted);
    const badMute = onRoute.filter(
      (s) => s.muted !== null && s.muted !== muted,
    );
    r.ok(
      `${label}: no frame shows the first track ${view.firstTrackMuted ? "unmuted" : "muted"}`,
      badMute.length === 0,
      `${badMute.length} frame(s)`,
    );
    r.ok(
      `${label}: no frame shows a display's empty-score message`,
      onRoute.every((s) => !s.noNotes),
    );
  };

  // ── Baselines ───────────────────────────────────────────────────────────
  const baseB = await openFresh(songB);
  const titleB = await page.getByLabel("Song title").inputValue();
  r.note(`B "${titleB}": ${JSON.stringify(baseB)}`);

  const baseA = await openFresh(songA);
  const titleA = await page.getByLabel("Song title").inputValue();
  const baseRowsA = await readTrackViews(songA);
  r.note(
    `A "${titleA}": ${JSON.stringify(baseA)}, ${baseRowsA.length} track-view row(s)`,
  );

  // A's new settings: each differs from A's own AND from B's, so a leak of
  // either song into the other is visible.
  const candidates = [2, 3, -2, -3, 4, -4];
  const target = candidates
    .map((d) => baseA.transpose + d)
    .find((t) => t >= -12 && t <= 12 && t !== baseB.transpose);
  if (target === undefined) throw new Error("no usable transpose target");
  const wantA: SongView = {
    transpose: target,
    chord: baseA.chord === "on" ? "off" : "on",
    firstTrackMuted: !baseA.firstTrackMuted,
  };
  const leaks = {
    chord: wantA.chord !== baseB.chord,
    mute: wantA.firstTrackMuted !== baseB.firstTrackMuted,
  };

  const restore = async () => {
    await api("POST", `/api/sonata/songs/${songA}/transpose`, {
      semitones: baseA.transpose,
    });
    await api("POST", `/api/sonata/songs/${songA}/chord-mode`, {
      enabled: baseA.chord === "on",
    });
    // The track view exactly as it was: drop every row, then re-write each.
    await api("DELETE", `/api/sonata/songs/${songA}/track-view`);
    for (const row of baseRowsA) {
      await api("POST", `/api/sonata/songs/${songA}/track-view`, {
        trackIds: [row.trackId],
        color: row.color,
        instrument: row.instrument,
        muted: row.muted,
        hidden: row.hidden,
        volume: row.volume,
      });
    }
    r.note("restored song A's transpose, chord mode and track view");
  };
  const unregister = onBeforeFinish(restore);

  try {
    // ── Set on A ──────────────────────────────────────────────────────────
    // Open the transpose popover from its header trigger, step in it, close.
    const trigger = page.getByRole("button", { name: /^Transpose\b/ });
    const step = page.getByRole("button", {
      name:
        target > baseA.transpose
          ? "Transpose up a semitone"
          : "Transpose down a semitone",
    });
    await reachInBar(page, trigger, async (button) => {
      await button.first().click();
      for (let i = 0; i < Math.abs(target - baseA.transpose); i++) {
        await step.click();
      }
      await page.keyboard.press("Escape");
    });
    await api("POST", `/api/sonata/songs/${songA}/chord-mode`, {
      enabled: wantA.chord === "on",
    });
    await pressFirstSpeaker();
    // Past the writes' round trips (and the chord-mode push).
    await page.waitForTimeout(1500);
    r.eq("A shows its new settings", await readView(), wantA);
    await snap(page, OUT, "1-a-set");

    // ── Persist ───────────────────────────────────────────────────────────
    await page.reload();
    await waitSettled();
    r.eq("A's settings survive a reload", await readView(), wantA);

    // ── A → B, in the app ─────────────────────────────────────────────────
    await startSampling();
    await switchInApp(songB, titleB);
    await page.waitForTimeout(500);
    const toB = await stopSampling();
    r.note(`${toB.length} frames sampled switching to B`);
    r.eq("B shows its own settings", await readView(), baseB);
    checkFrames("A → B", toB, songB, baseB);
    r.ok(
      "no frame on B shows A's transpose",
      toB.every(
        (s) =>
          s.path !== songPath(songB) ||
          s.transpose === null ||
          parseTranspose(s.transpose) !== target,
      ),
    );
    if (leaks.chord)
      r.note("B's chord mode differs from A's: a leak would have shown");
    if (leaks.mute)
      r.note("B's first-track mute differs from A's: a leak would have shown");
    await snap(page, OUT, "2-b");

    // ── B → A, in the app ─────────────────────────────────────────────────
    await startSampling();
    await switchInApp(songA, titleA);
    await page.waitForTimeout(500);
    const toA = await stopSampling();
    r.note(`${toA.length} frames sampled switching back to A`);
    r.eq("A shows its settings again", await readView(), wantA);
    checkFrames("B → A", toA, songA, wantA);
    await snap(page, OUT, "3-a-again");

    // ── A playing in the background → B's card ────────────────────────────
    // A is the open song (played from its card, no player), so B's player
    // loads B's content while A is still open: the window where A's settings
    // once rendered over B's content for a frame.
    await playInBackground(titleA);
    r.note("A plays in the background from its library card");
    await startSampling();
    await openCard(songB, titleB);
    await page.waitForTimeout(500);
    const bgToB = await stopSampling();
    r.note(`${bgToB.length} frames sampled opening B over A's background play`);
    r.eq(
      "B (opened over A's background play) shows its own settings",
      await readView(),
      baseB,
    );
    checkFrames("A playing → B", bgToB, songB, baseB);
    r.ok(
      "no frame on B shows A's transpose while A played in the background",
      bgToB.every(
        (s) =>
          s.path !== songPath(songB) ||
          s.transpose === null ||
          parseTranspose(s.transpose) !== target,
      ),
    );
    r.ok(
      "B opens stopped: A's background playback does not play on over it",
      await transportStopped(),
    );
    await snap(page, OUT, "4-b-over-a-playing");

    // ── B playing in the background → A's card ────────────────────────────
    await playInBackground(titleB);
    r.note("B plays in the background from its library card");
    await startSampling();
    await openCard(songA, titleA);
    await page.waitForTimeout(500);
    const bgToA = await stopSampling();
    r.note(`${bgToA.length} frames sampled opening A over B's background play`);
    r.eq(
      "A (opened over B's background play) shows its own settings",
      await readView(),
      wantA,
    );
    checkFrames("B playing → A", bgToA, songA, wantA);
    r.ok(
      "no frame on A shows B's transpose while B played in the background",
      bgToA.every(
        (s) =>
          s.path !== songPath(songA) ||
          s.transpose === null ||
          parseTranspose(s.transpose) !== baseB.transpose,
      ),
    );
    r.ok(
      "A opens stopped: B's background playback does not play on over it",
      await transportStopped(),
    );
    await snap(page, OUT, "5-a-over-b-playing");
  } finally {
    unregister();
    await restore();
  }

  await r.finish();
});
