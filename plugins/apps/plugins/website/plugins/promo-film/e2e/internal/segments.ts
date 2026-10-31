// The film's session, as recorded segments of the REAL app on the seeded
// `promo-film` composition: every pane, morph, popover and app switch is the
// app's own, triggered by real pointer and keyboard input on the recorder's
// virtual clock (media/film `record`). Each segment boots its route in real
// time (unrecorded), then records; each is re-recordable on its own
// (`record.ts --only <name>`). Consecutive segments join only where the
// session is continuous — one ends in the very state the next opens on — or
// at a time-lapse, where the film cuts on purpose.
//
//   integrated  Home → Pages → Piano → the conversation chip → Expand (the
//               pane → app morph) → the file chip → the file preview → Expand
//               (Files) → Open in Sonata → Play → Pause.
//   sonata      Wish "show the current key…" + "Auto-push and exit" → Create
//               task; during the time-lapse the agent's config change shows
//               the section (the slot layout's real `hidden` flag, reset
//               through the Config pane's own write); its card is opened.
//               Then the app launcher's grid → Chord → the grid again → Pages
//               → "Lisbon in May".
//   lisbon      Wish "holiday ideas, with a map" → Launch; during the
//               time-lapse the agent writes place blocks and a map block
//               through the page editor's own endpoint. Then the launcher →
//               Places (opening where the user left its map, on Lisbon), a
//               real zoom out over every saved place, and from there a Wish
//               "I'd like a P2P messaging app" (marks `…-create`).
//   prototype   Circle in Prototypes: This window → + (a second frame) →
//               its Theme: Light → Phone → swipe, the real slider dragged;
//               then a new Wish, "Good, implement it", → Create task.
//   desktop     equin's desktop mode, arranged as a user's: Pages snapped
//               left, Places and Sonata stacked right, Circle on top.

import type { Page } from "playwright";
import {
  pageFetch,
  type Harness,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  createBlock,
  type CreateBlockBody,
} from "@plugins/page/plugins/editor/core";
import { resetConfigField } from "@plugins/config_v2/plugins/settings/core";
import {
  LISBON_IDEAS,
  SONATA_SECTION_LAYOUT,
} from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/core";
import {
  installRecorderClock,
  record,
  type Recorder,
  type Sequence,
} from "@plugins/media/plugins/film/e2e";
import {
  DPR,
  H,
  open,
  readSegmentFacts,
  REC_DIR,
  visible,
  W,
  writeSegmentFacts,
} from "./session-kit";
import { recordSonataAudio } from "./sonata-audio";

/** The seeded story's ids (seed/machine/internal/story). */
const LISBON = "block-1792800000-film30";
/** The Lisbon page's last block: the holiday ideas go after it. */
const LISBON_LAST = "block-1792800000-film34";
const PROTO = "proto-1792779833-4wgtuf";
const CONV_CHIP =
  'button[data-tooltip^="Practice MIDI for the Fantaisie-Impromptu"]';
const MIDI_CHIP = "practice/fantaisie-impromptu.mid";
/** Where the user left the Places map: Lisbon (the map's remembered view). */
const LISBON_VIEW = { center: { lat: 38.716, lng: -9.165 }, zoom: 13 };

export const PROMPTS = {
  sonata: "Show the current key in the song panel",
  lisbon: "Add a few holiday ideas for these four days, with a map",
  create: "I'd like a P2P messaging app",
  implement: "Good, implement it",
} as const;

export interface SegmentCtx {
  h: Harness;
}

type SegmentFn = (c: SegmentCtx) => Promise<Sequence>;

/** A fresh browser context on the virtual clock, at the film's viewport. */
async function session(h: Harness): Promise<Page> {
  const { page, context } = await h.session({
    viewport: { width: W, height: H },
    deviceScaleFactor: DPR,
    colorScheme: "dark",
    capture: false,
  });
  await installRecorderClock(context);
  return page;
}

const rec = (
  page: Page,
  name: string,
  cursor: { x: number; y: number },
  script: (r: Recorder) => Promise<void>,
): Promise<Sequence> =>
  // A first open of Places fetches every saved place's photo from Google:
  // a frame may wait that long, the page's clock frozen meanwhile.
  record(
    page,
    { dir: REC_DIR, name, cursor, settle: { timeoutMs: 180_000 } },
    script,
  );

/**
 * Hover the collapsed global action bar open (it expands toward the left).
 * The pointer comes in from the left along the top: on a page, the outline
 * marker sits on the right edge below the bar, and passing over it opens it.
 */
async function openBar(r: Recorder): Promise<void> {
  await r.move({ x: 1110, y: 70 }, { duration: 0.6 });
  await r.move({ x: 1236, y: 22 }, { duration: 0.35 });
  await r.hold(0.45);
}

/** The Wish popover's prompt editor (the last contenteditable on the page). */
const editorOf = (page: Page) =>
  page.locator('[contenteditable="true"]').last();

/**
 * A Wish, as a user makes it: the bar's Wish button, the prompt typed one
 * character at a time (marks `typing` / `typed`), the "Auto-push and exit"
 * preprompt, then its submit ("Launch", or "Create task") — mark
 * `submitted`. Then the pointer rests.
 */
async function wish(
  r: Recorder,
  page: Page,
  prompt: string,
  rest: { x: number; y: number },
  /** Suffix of its marks, for a segment holding two Wishes. */
  tag = "",
): Promise<void> {
  await openBar(r);
  await r.click(page.getByRole("button", { name: "Wish", exact: true }), {
    duration: 0.35,
  });
  await r.hold(0.45);
  const editor = editorOf(page);
  await r.click({ element: editor, at: { x: 0.5, y: 0.3 } });
  await r.mark(`typing${tag}`, editor);
  await r.type(prompt, { cps: 19 });
  await r.mark(`typed${tag}`);
  await r.hold(0.25);
  await r.click(page.locator('button[aria-label="Preprompt"]').first());
  await r.hold(0.35);
  await r.click(page.getByText("Auto-push and exit", { exact: true }).last());
  await r.hold(0.35);
  // "Create task", or "Launch" once a launch option (the preprompt) is set.
  const create = page.getByRole("button", { name: /^(Create task|Launch)\b/ });
  await r.click(create.first());
  await r.mark(`submitted${tag}`);
  await r.move(rest, { duration: 0.8 });
  await r.hold(0.2);
}

/** Keep recording (the page's time running) until `loc` is visible, at most `max` seconds. */
async function holdUntil(
  r: Recorder,
  loc: ReturnType<Page["locator"]>,
  max: number,
): Promise<void> {
  for (let waited = 0; ; waited += 0.1) {
    if (await loc.first().isVisible()) return;
    if (waited > max)
      throw new Error(`promo-film: ${String(loc)} never appeared (${max} s)`);
    await r.hold(0.1);
  }
}

/** The app launcher's grid (hovering the app's own icon) → the app `rowKey`. */
async function viaLauncher(
  r: Recorder,
  page: Page,
  rowKey: string,
  mark: string,
): Promise<void> {
  const launcher = page.locator('button[aria-label="All apps"]').first();
  await r.move(launcher, { duration: 0.7 });
  await r.hold(0.75);
  const icon = page.locator(`[role="button"][data-row-key="${rowKey}"]`);
  await r.mark(`${mark}-grid`, icon.first());
  await r.click(icon.first(), { duration: 0.5 });
  await r.mark(mark);
}

/** One block written as an agent writes a page: the editor's own create-block endpoint, right after `afterId`. Returns its id. */
async function writeBlock(
  page: Page,
  block: Omit<CreateBlockBody, "afterId">,
  afterId: string,
): Promise<string> {
  const [method = "", path = ""] = createBlock.route.split(" ");
  const body: CreateBlockBody = { ...block, afterId };
  const res = await pageFetch(page, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `promo-film: writing a block failed: ${res.status} ${await res.text()}`,
    );
  return ((await res.json()) as { id: string }).id;
}

// ------------------------------------------------------------------------

const integrated: SegmentFn = async ({ h }) => {
  const page = await session(h);
  await open(page, "/home");
  const pagesTile = page.locator('[role="button"][data-row-key="pages"]');
  await visible(pagesTile);
  const song: {
    path: string | null;
    playheadAtEnd: number | null;
    pausedAt: number | null;
  } = { path: null, playheadAtEnd: null, pausedAt: null };
  const seq = await rec(page, "integrated", { x: 700, y: 610 }, async (r) => {
    await r.hold(0.6);
    await r.mark("home-click", pagesTile);
    await r.click(pagesTile, { duration: 0.7 });
    await r.hold(0.5);
    await r.click(page.getByText("Piano", { exact: true }).first(), {
      duration: 0.6,
    });
    await r.mark("piano");
    const chip = page.locator(CONV_CHIP).first();
    await r.hold(0.9);
    await r.mark("chip", chip);
    await r.click(chip, { duration: 0.8 });
    await r.mark("conversation");
    await r.hold(1.2);
    await r.click(
      page
        .locator(
          '[data-pane-id="conversation"] button[aria-label="Open in Agent Manager"]',
        )
        .first(),
      { duration: 0.6 },
    );
    await r.mark("agent-manager");
    await r.hold(1.0);
    await r.click(page.locator("button", { hasText: MIDI_CHIP }).first(), {
      duration: 0.75,
    });
    await r.mark("file-peek");
    await r.hold(1.1);
    await r.click(
      page
        .locator(
          '[data-pane-id="file-peek"] button[aria-label="Open in Files"]',
        )
        .first(),
      { duration: 0.6 },
    );
    await r.mark("files");
    await r.hold(0.9);
    await r.click(
      page.getByRole("button", { name: "Open in Sonata" }).first(),
      { duration: 0.6 },
    );
    await r.mark("sonata");
    await r.hold(0.7);
    const play = page.getByRole("button", { name: "Play", exact: true });
    await r.mark("play", play.first());
    await r.click(play.first(), { duration: 0.5 });
    await r.mark("playing");
    // A first Play waits on the piano's samples (~2 s); then the left hand's
    // arpeggios, and the right hand's entry at ~5.8 s.
    await r.hold(8.5);
    // Where the player's clock stands now: the film reads when playback
    // really started from it.
    await r.mark("clock-read");
    const shown = await page
      .getByText(/^\d+:\d\d\.\d$/)
      .first()
      .textContent();
    const mm = /^(\d+):(\d\d\.\d)$/.exec(shown ?? "");
    if (!mm)
      throw new Error(`promo-film integrated: no player time (${shown})`);
    song.playheadAtEnd = Number(mm[1]) * 60 + Number(mm[2]);
    song.path = new URL(page.url()).pathname;
    await r.click(page.getByRole("button", { name: "Pause", exact: true }), {
      duration: 0.3,
    });
    await r.mark("paused");
    const at = /^(\d+):(\d\d\.\d)$/.exec(
      (await page
        .getByText(/^\d+:\d\d\.\d$/)
        .first()
        .textContent()) ?? "",
    );
    if (!at) throw new Error("promo-film integrated: no player time at pause");
    song.pausedAt = Number(at[1]) * 60 + Number(at[2]);
    await r.hold(0.4);
  });
  if (
    song.path === null ||
    song.playheadAtEnd === null ||
    song.pausedAt === null
  )
    throw new Error("promo-film integrated: never reached Play");
  // The song as the user left it (its URL names the bar), for `sonata`.
  writeSegmentFacts("integrated", {
    playheadAtEnd: song.playheadAtEnd,
    pausedAt: song.pausedAt,
    songPath: song.path,
  });
  // The piano the picture shows, from the start, in real time.
  await recordSonataAudio(h, song.path);
  return seq;
};

const sonata: SegmentFn = async ({ h }) => {
  const { songPath, pausedAt } = readSegmentFacts("integrated");
  if (songPath === undefined || pausedAt === undefined)
    throw new Error("promo-film sonata: record `integrated` first");
  const page = await session(h);
  await open(page, songPath, { settleMs: 4000 });
  // Where `integrated` left the song: played up to its pause point (the
  // player's own clock, read to the tenth), then paused — off camera.
  const play = page.getByRole("button", { name: "Play", exact: true });
  await visible(play);
  await play.click();
  // Paused from inside the page the instant its clock shows the time
  // `integrated` paused at (the display's own tenth of a second).
  await page.evaluate(
    (target) =>
      new Promise<void>((resolve, reject) => {
        const re = /^(\d+):(\d\d\.\d)$/;
        const t0 = performance.now();
        const tick = (): void => {
          const shown = Array.from(document.querySelectorAll("*")).find(
            (e) => e.children.length === 0 && re.test(e.textContent ?? ""),
          );
          const mm = re.exec(shown?.textContent ?? "");
          if (mm && Number(mm[1]) * 60 + Number(mm[2]) >= target) {
            const pause = Array.from(document.querySelectorAll("button")).find(
              (b) => b.getAttribute("aria-label") === "Pause",
            );
            if (!pause) {
              reject(new Error("no Pause button"));
              return;
            }
            pause.click();
            resolve();
            return;
          }
          if (performance.now() - t0 > 60_000) {
            reject(new Error("the song never reached its pause point"));
            return;
          }
          setTimeout(tick, 2);
        };
        tick();
      }),
    pausedAt,
  );
  await page.waitForTimeout(800);
  // The Chord app's song index is built by a job after the seed.
  const chordReady = async (): Promise<void> => {
    const probe = await h.session({ capture: false });
    await open(probe.page, "/chord");
    await visible(
      probe.page.getByText("Now listening", { exact: true }),
      180_000,
    );
    await probe.context.close();
  };
  await chordReady();
  const [method = "", path = ""] = resetConfigField.route.split(" ");
  // The pointer where `integrated` left it: on the Pause (now Play) button.
  const pb = await play.boundingBox();
  if (!pb) throw new Error("promo-film sonata: no Play button");
  return rec(
    page,
    "sonata",
    { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 },
    async (r) => {
      await r.hold(0.5);
      await wish(r, page, PROMPTS.sonata, { x: 1080, y: 560 });
      // Time-lapse: the agent shows the section — the layout's own `hidden`
      // flag, reset through the Config pane's write.
      await r.mark("lapse");
      await r.hold(1.5);
      const res = await pageFetch(page, path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storePath: SONATA_SECTION_LAYOUT,
          key: "items",
        }),
      });
      if (!res.ok)
        throw new Error(
          `promo-film sonata: the config change failed: ${res.status} ${await res.text()}`,
        );
      // The page renders the pushed change only as its (virtual) time runs.
      await holdUntil(r, page.getByText("Current key", { exact: true }), 6);
      await r.hold(1.0);
      await r.mark("lapsed");
      await r.hold(0.6);
      const keyRow = page.getByText("Current key", { exact: true }).first();
      await r.mark("key-row", keyRow);
      await r.click(keyRow, { duration: 0.7 });
      await r.mark("key-open");
      await r.hold(2.2);
      await viaLauncher(r, page, "chord", "chord");
      await r.hold(1.6);
      await viaLauncher(r, page, "pages", "pages");
      await r.hold(0.5);
      await r.click(page.getByText("Lisbon in May", { exact: true }).first(), {
        duration: 0.6,
      });
      await r.mark("lisbon");
      await r.hold(0.8);
    },
  );
};

/** A map's remembered view, as the map stores the place the user left it. */
async function rememberMapView(page: Page, key: string): Promise<void> {
  await page.evaluate(
    ([k, v]) =>
      localStorage.setItem(
        `s:map.camera:${k}`,
        JSON.stringify({ v, ts: Date.now() }),
      ),
    [key, LISBON_VIEW] as const,
  );
}

const lisbon: SegmentFn = async ({ h }) => {
  const page = await session(h);
  await open(page, `/pages/page/${LISBON}`);
  if ((await page.getByText("Castelo de São Jorge").count()) > 0)
    throw new Error(
      "promo-film lisbon: the Lisbon page already holds the map — re-seed first",
    );
  // The user last looked at their Places map over Lisbon, its list in
  // Gallery view (cards with photos).
  await rememberMapView(page, "places.map");
  await open(page, "/places", { settleMs: 4000 });
  await page.locator('button[data-tooltip="Gallery"]').first().click();
  await page.waitForTimeout(1500);
  await open(page, `/pages/page/${LISBON}`);
  await visible(page.getByText("Lisbon in May", { exact: true }));
  return rec(page, "lisbon", { x: 60, y: 241 }, async (r) => {
    await r.hold(0.5);
    await wish(r, page, PROMPTS.lisbon, { x: 1080, y: 600 });
    // Time-lapse: the agent writes the ideas, each a real Google place the
    // page resolves itself, then the map that draws them.
    await r.mark("lapse");
    let after = LISBON_LAST;
    after = await writeBlock(
      page,
      { type: "heading-2", data: { text: [{ text: "Ideas" }] } },
      after,
    );
    for (const idea of LISBON_IDEAS) {
      await r.hold(0.6);
      after = await writeBlock(
        page,
        {
          type: "place",
          data: { providerId: "google", placeId: idea.placeId },
        },
        after,
      );
    }
    await r.hold(0.6);
    await writeBlock(page, { type: "map", data: {} }, after);
    await r.hold(1.6);
    await r.mark("lapsed");
    // The map lands below the fold: the user scrolls to it.
    await r.move({ x: 760, y: 420 }, { duration: 0.6 });
    await r.wheel(520, { duration: 1.0 });
    await r.mark("map");
    await r.hold(1.6);
    await viaLauncher(r, page, "places", "places");
    await r.hold(1.4);
    // Zoom out over the map: every saved place, the world over.
    await r.move({ x: 560, y: 380 }, { duration: 0.6 });
    await r.mark("zoom-out");
    for (let i = 0; i < 6; i++) {
      await r.wheel(300, { duration: 0.3 });
      await r.hold(0.12);
    }
    // The rest of the way with the panel's own "Fit map": every saved place.
    await r.hold(0.3);
    await r.click(page.getByText("Fit map", { exact: true }).first(), {
      duration: 0.7,
    });
    await r.mark("world");
    await r.hold(1.4);
    // Create any app: from here, a Wish for a new one.
    await wish(r, page, PROMPTS.create, { x: 1080, y: 560 }, "-create");
    await r.hold(1.6);
  });
};

/** Circle's canvas, open and drawn. */
async function circleOpen(page: Page): Promise<void> {
  await visible(page.getByRole("button", { name: "This window" }));
  await page.waitForFunction(
    () =>
      (document.querySelector("iframe")?.getBoundingClientRect().width ?? 0) >
      300,
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2500);
}

/**
 * Circle's canvas driven, off camera, to the state the prototype segment ends
 * in (This window, a second frame in the light theme, phones, the swipe at
 * rest), so its desktop window shows what the film just showed.
 */
async function circleAsLeft(
  page: Page,
  /** Where Circle's canvas is: the page, or its desktop window (other windows hold iframes too). */
  scope: Page | ReturnType<Page["locator"]> = page,
): Promise<void> {
  const pause = () => page.waitForTimeout(900);
  await scope.getByRole("button", { name: "This window" }).click();
  await pause();
  await scope.locator("iframe").first().hover();
  await scope
    .locator('button[aria-label="Add a frame to compare"]')
    .first()
    .click();
  await pause();
  // A frame's header (its options pill) shows while the pointer is over it.
  await scope.locator("iframe").nth(1).hover();
  await page.waitForTimeout(400);
  await scope.locator('button[aria-label="Prototype options"]').nth(1).click();
  await pause();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await pause();
  await page.keyboard.press("Escape");
  await pause();
  await scope.getByRole("button", { name: "Phone", exact: true }).click();
  await pause();
  await scope
    .locator('button[aria-label="Swipe one frame over the other"]')
    .first()
    .click();
  await page.waitForTimeout(1500);
}

const prototype: SegmentFn = async ({ h }) => {
  const page = await session(h);
  await open(page, `/prototypes/proto/${PROTO}`);
  await circleOpen(page);
  return rec(page, "prototype", { x: 1100, y: 560 }, async (r) => {
    await r.hold(0.5);
    await r.click(page.getByRole("button", { name: "This window" }), {
      duration: 0.7,
    });
    await r.hold(0.5);
    // The add-frame rail shows while the pointer is over the frame.
    await r.move({ x: 960, y: 470 }, { duration: 0.5 });
    await r.hold(0.2);
    await r.click(
      page.locator('button[aria-label="Add a frame to compare"]').first(),
      { duration: 0.5 },
    );
    await r.mark("pair");
    await r.hold(0.6);
    // The second frame's options: its Theme → Light.
    const options = page.locator('button[aria-label="Prototype options"]');
    await r.click(options.nth(1), { duration: 0.6 });
    await r.hold(0.35);
    await r.click(page.getByRole("radio", { name: "Light", exact: true }), {
      duration: 0.5,
    });
    await r.hold(0.35);
    await r.press("Escape");
    await r.hold(0.5);
    await r.click(page.getByRole("button", { name: "Phone", exact: true }), {
      duration: 0.7,
    });
    await r.mark("phones");
    await r.hold(0.7);
    await r.click(
      page
        .locator('button[aria-label="Swipe one frame over the other"]')
        .first(),
      { duration: 0.6 },
    );
    await r.mark("swipe");
    await r.hold(0.4);
    // The real slider: its divider dragged across the two variants.
    const handle = page.locator(
      '[role="separator"][aria-label^="Drag to swipe"]',
    );
    const box = await handle.first().boundingBox();
    if (!box)
      throw new Error("promo-film prototype: the swipe handle has no box");
    const hx = box.x + box.width / 2;
    const hy = box.y + box.height / 2;
    const frame = await page.locator("iframe").first().boundingBox();
    if (!frame) throw new Error("promo-film prototype: no frame");
    const at = (f: number) => ({ x: frame.x + frame.width * f, y: hy });
    await r.drag({ x: hx, y: hy }, at(0.12), { duration: 0.8 });
    await r.hold(0.2);
    await r.drag(at(0.12), at(0.88), { duration: 1.1 });
    await r.hold(0.2);
    await r.drag(at(0.88), { x: hx, y: hy }, { duration: 0.7 });
    await r.mark("swiped");
    await r.hold(0.5);
    // The next step: build it.
    await wish(r, page, PROMPTS.implement, { x: 1100, y: 600 });
    await r.mark("lapse");
    await r.hold(2.4);
    // The phone the film ends on: the desktop reveal aligns its window's on it.
    await r.mark("phone", page.locator("iframe").first());
  });
};

const desktop: SegmentFn = async ({ h }) => {
  const page = await session(h);
  await open(page, "/desktop", { settleMs: 3000, untitled: true });
  const pause = (ms = 2500) => page.waitForTimeout(ms);
  const shelf = async (label: string): Promise<void> => {
    await page.locator(`button[aria-label="${label}"]`).first().click();
    await pause();
  };
  const launch = async (app: string): Promise<void> => {
    await shelf("Apps");
    await page.keyboard.type(app);
    await pause(500);
    await page.keyboard.press("Enter");
    await pause(3500);
  };
  /** Snap the focused window with the desktop's own Ctrl+Alt+arrow shortcuts. */
  const snap = async (
    ...dirs: ("Left" | "Right" | "Up" | "Down")[]
  ): Promise<void> => {
    for (const d of dirs) {
      await page.keyboard.press(`Control+Alt+Arrow${d}`);
      await pause(900);
    }
  };
  /**
   * Open a window and return its title tab's text — the page it shows
   * ("Library" for Sonata), not the app's name: the tab that was not there.
   */
  const opened = async (openIt: () => Promise<void>): Promise<string> => {
    const tabs = () =>
      page
        .locator('[role="tab"]')
        .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
    const before = await tabs();
    await openIt();
    const fresh = (await tabs()).filter((t) => !before.includes(t));
    if (fresh.length !== 1)
      throw new Error(
        `promo-film desktop: expected one new window, got ${JSON.stringify(fresh)}`,
      );
    return fresh[0]!;
  };
  // A user's desktop: Pages snapped to the left half, Places and Sonata
  // stacked on the right, and Circle open on top of them.
  // Places opens where the user left its map: over Lisbon.
  await rememberMapView(page, "places.map");
  await opened(() => shelf("Pages"));
  await snap("Left");
  await opened(() => launch("Places"));
  await snap("Right", "Up");
  // In a quarter-screen window its list would cover the map: hidden, as a
  // user would (the panel's own "Hide the list").
  await page.locator('button[aria-label="Hide the list"]').last().click();
  await pause(1500);
  await opened(() => shelf("Sonata"));
  await snap("Right", "Down");
  await launch("Prototypes");
  await page.locator('input[placeholder="Search…"]').last().fill("Circle");
  await pause(1500);
  await page.getByText("Circle — P2P friends", { exact: true }).first().click();
  await circleOpen(page);
  const win = page.locator('[data-film="circle-window"]');
  const tagWindow = () =>
    page
      .locator('[role="tab"]', { hasText: "Circle — P2P friends" })
      .first()
      .evaluate((el) => {
        document
          .querySelector('[data-film="circle-window"]')
          ?.removeAttribute("data-film");
        const w = el.closest('[data-ui-owner^="TabContainer"]');
        if (!w) throw new Error("promo-film desktop: Circle has no window");
        w.setAttribute("data-film", "circle-window");
      });
  await tagWindow();
  // Circle floats on top, a little smaller than it opened: its own
  // bottom-right resize handle dragged in.
  const box = await win.boundingBox();
  if (!box) throw new Error("promo-film desktop: Circle's window has no box");
  const corner = await page.evaluate(
    ({ x, y }) => {
      let best: { x: number; y: number; d: number } | null = null;
      for (const el of Array.from(
        document.querySelectorAll(".cursor-se-resize"),
      )) {
        const r = el.getBoundingClientRect();
        const c = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        const d = Math.hypot(c.x - x, c.y - y);
        if (!best || d < best.d) best = { ...c, d };
      }
      return best;
    },
    { x: box.x + box.width, y: box.y + box.height },
  );
  if (!corner || corner.d > 20)
    throw new Error("promo-film desktop: no resize handle at Circle's corner");
  const target = { w: 760, h: 500 };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(
    corner.x - (box.width - target.w),
    corner.y - (box.height - target.h),
    { steps: 12 },
  );
  await page.mouse.up();
  await pause(1500);
  await tagWindow();
  const after = await win.boundingBox();
  if (!after || after.y + after.height > 650)
    throw new Error(
      `promo-film desktop: Circle's window reaches the shelf (${JSON.stringify(after)})`,
    );
  await circleAsLeft(page, win);
  // The setup's drags may leave a text selection behind; a user's desktop has none.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(W / 2, 30);
  await pause(1500);
  return rec(page, "desktop", { x: W / 2, y: 30 }, async (r) => {
    await r.mark("circle-window", win);
    await r.mark("phone", win.locator("iframe").first());
    // The film draws no pointer here (the camera pulls back over it).
    await r.hold(4.0);
  });
};

export const SEGMENTS: Record<string, SegmentFn> = {
  integrated,
  sonata,
  lisbon,
  prototype,
  desktop,
};
