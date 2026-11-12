// The film's session (Script v4), as recorded segments of the REAL app on the
// seeded `promo-film` composition: every pane, morph, popover and app switch
// is the app's own, triggered by real pointer and keyboard input on the
// recorder's virtual clock (media/film `record`). Each segment boots its route
// in real time (unrecorded), then records; each is re-recordable on its own
// (`record.ts --only <name>`), and each but the first opens where the one
// before ended (`continueFrom`: its route and its pointer).
//
//   pages       Home → Pages (Music open in the sidebar) → Buying a piano (a
//               short page: a sentence, three bullets, then the user's
//               checklist of shops, each with its place) → Wish "Add more
//               piano shops to this page" → Create task; the agent extends
//               the list live in one edit (no time-lapse): more shops, a
//               map — the camera framing the room as it lands, then following
//               the arrival down to the map, centred → the map's expand →
//               Places grows out of the map → a shop's detail → its photos
//               → back out → Wish with Pick UI on a whole card: "Add opening
//               times to the cards" → Auto-push and exit; during the
//               time-lapse the place-cards setting turns the hours on (they
//               ease in) → the launcher → Files. ONE recording, so the map
//               Places grows out of is the same live map through the scene
//               (a join re-loaded it, and Google laid its labels out anew:
//               the whole-map flash right after Places opened).
//   sonata      Files: unfold scores → the score page's preview → unfold
//               music → the MIDI's preview → Open in Sonata (Sonata grows out
//               of the button, the song playing on — one recording, so
//               playback never jumps) → Wish with Pick UI on the song panel →
//               "Add a section to show the song key" → Auto-push and exit;
//               the section animates in (highlighted as it appears) → Wish
//               "I'd like a P2P messaging app" → Create task (no time-lapse)
//               → the launcher → Agent Manager → its conversation, ending on
//               "Your prototype is ready".
//   prototype   The conversation's prototype chip (right there, no scroll) →
//               the prototype beside it → Expand (Prototypes) → a second
//               frame, its variant (Light), Phone, This window, the real
//               swipe slider there → Wish
//               "Good, implement it" → Create task; during the time-lapse
//               Circle is un-hidden → the launcher's All apps → Home,
//               Circle's tile.
//   desktop     equin's desktop mode at a higher resolution with ONE window:
//               Home's gallery; then every app opening in a window of its
//               own at the size its layout is comfortable at, each landing
//               on top of the earlier ones (the montage); then Home's window
//               raised again, and its Full screen control: the gallery grows
//               into the whole screen.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  pageFetch,
  type Harness,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { configValues, setConfigField } from "@plugins/config_v2/core";
import { resetConfigField } from "@plugins/config_v2/plugins/settings/core";
import {
  APP_LAYOUT,
  filmAppLayout,
  FILM_PAGES_OPENED,
  finishFilmAgentRun,
  PIANO_SHOP_LIST,
  PIANO_SHOPS_ADDED,
  PLACES_HOURS_CONFIG,
  SONATA_KEY_SECTION,
  SONATA_SECTION_LAYOUT,
  writeFilmShops,
} from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/core";
import {
  installRecorderClock,
  record,
  type Recorder,
  type RecTarget,
  type Sequence,
} from "@plugins/media/plugins/film/e2e";
import {
  DPR,
  H,
  open,
  continueFrom,
  endHere,
  filmDate,
  REC_DIR,
  visible,
  W,
} from "./session-kit";

const SCORE_IMAGE = "wedding-day-at-troldhaugen-page-1.png";
const MIDI = "wedding-day-at-troldhaugen.mid";

export const PROMPTS = {
  key: "Add a section below to show the song key",
  shops: "Add more piano shops to this page",
  hours: "Add opening times to the cards",
  create: "I'd like a P2P messaging app",
  implement: "Good, implement it",
} as const;

export interface SegmentCtx {
  h: Harness;
}

type SegmentFn = (c: SegmentCtx) => Promise<Sequence>;

/**
 * A fresh browser context on the virtual clock, at the film's viewport — or,
 * `screen`, a larger screen (the desktop's: {@link DESK}).
 */
async function session(
  h: Harness,
  screen: { width: number; height: number; dpr: number } = {
    width: W,
    height: H,
    dpr: DPR,
  },
): Promise<Page> {
  const { page, context } = await h.session({
    viewport: { width: screen.width, height: screen.height },
    deviceScaleFactor: screen.dpr,
    colorScheme: "dark",
    capture: false,
  });
  // The film's calendar (the seed's weekday afternoon), not today's.
  await installRecorderClock(context, { date: filmDate() });
  await context.addInitScript(watchHealthDot);
  return page;
}

/**
 * Every change of the health report's dot (its state and verdict — the
 * button's `data-health` and accessible name), with the page's time: the
 * film's "machine noise never shows" made checkable. Runs in the page.
 */
function watchHealthDot(): void {
  const w = window as unknown as {
    __filmHealth?: { t: number; state: string; label: string }[];
  };
  w.__filmHealth = [];
  let last = "";
  const read = () => {
    const b = document.querySelector("[data-health]");
    if (!b) return;
    const state = b.getAttribute("data-health") ?? "";
    const label = b.getAttribute("aria-label") ?? "";
    const key = `${state}|${label}`;
    if (key === last) return;
    last = key;
    w.__filmHealth!.push({ t: performance.now(), state, label });
  };
  new MutationObserver(read).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-health", "aria-label"],
  });
}

/** The dot's changes during a recording, written beside it; each non-ok one logged. */
async function reportHealth(
  page: Page,
  name: string,
  start: number,
): Promise<void> {
  const all = (await page.evaluate(
    () =>
      (window as unknown as { __filmHealth?: unknown[] }).__filmHealth ?? [],
  )) as { t: number; state: string; label: string }[];
  // Recording time (s): before 0 is the unrecorded pre-roll.
  const log = all.map((e) => ({ ...e, t: (e.t - start) / 1000 }));
  writeFileSync(
    join(REC_DIR, `${name}.health.json`),
    JSON.stringify(log, null, 1),
  );
  const bad = log.filter((e) => e.t >= 0 && e.state !== "ok");
  if (bad.length > 0)
    console.warn(
      `promo-film ${name}: the health dot left ok ${bad.length}× — ${bad
        .slice(0, 6)
        .map((e) => `${e.state} "${e.label}" @${e.t.toFixed(2)}s`)
        .join("; ")}`,
    );
}

const rec = async (
  page: Page,
  name: string,
  cursor: { x: number; y: number },
  script: (r: Recorder) => Promise<void>,
): Promise<Sequence> => {
  // The page's time the recording starts at: the health log's zero.
  const start = await page.evaluate(() => performance.now());
  // A first open of Places fetches every place's photo from Google: a frame
  // may wait that long, the page's clock frozen meanwhile.
  const seq = await record(
    page,
    { dir: REC_DIR, name, cursor, settle: { timeoutMs: 180_000 } },
    script,
  );
  await reportHealth(page, name, start);
  return seq;
};

/**
 * A JSON POST to one of the app's endpoints, from the page (its origin, its
 * auth). Its JSON answer, or `undefined` for an endpoint that answers with no
 * body (a config write).
 */
async function post(
  page: Page,
  endpoint: { route: string },
  body: unknown,
): Promise<unknown> {
  const [method = "", path = ""] = endpoint.route.split(" ");
  const res = await pageFetch(page, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `promo-film: ${endpoint.route} failed: ${res.status} ${await res.text()}`,
    );
  const text = await res.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/**
 * Show Circle in the launchers, right after Browser: the instance's app layout
 * as it reads now (the seed's, Circle hidden there) with the `hidden` flag
 * dropped, written back through the Config pane's write. Never a reset to the
 * committed layout: Circle is film-only, so main's layout does not name it and
 * a reset would leave it to the reorder safety net — appended last.
 */
async function showCircle(page: Page): Promise<void> {
  const res = await pageFetch(
    page,
    `/api/resources/${configValues.key}?path=${encodeURIComponent(APP_LAYOUT)}`,
  );
  if (!res.ok)
    throw new Error(
      `promo-film: reading ${APP_LAYOUT} failed: ${res.status} ${await res.text()}`,
    );
  const { value } = (await res.json()) as { value: { items?: unknown } };
  if (!Array.isArray(value.items))
    throw new Error(`promo-film: ${APP_LAYOUT} has no items layout`);
  await post(page, setConfigField, {
    storePath: APP_LAYOUT,
    key: "items",
    value: filmAppLayout(value.items, "shown"),
  });
}

/**
 * Hover the collapsed global action bar open (it expands toward the left).
 * The pointer comes in from the left along the top: on a page, the outline
 * marker sits on the right edge below the bar, and passing over it opens it.
 */
async function openBar(r: Recorder, pace: Pace): Promise<void> {
  // ONE gesture curving in along the top (never a stop at the waypoint) —
  // from the left only: a hand already right of the waypoint goes straight
  // up to the bar (curving out to it and back was a hook).
  const bar = { x: 1236, y: 22 };
  const via = { x: 1110, y: 70 };
  await r.move(bar, {
    via: r.cursor.x < via.x ? [via] : [],
    duration: pace === "first" ? 0.9 : 0.7,
  });
  // The bar unfolds under the hand.
  await r.hold(pace === "first" ? 0.3 : 0.2);
}

/**
 * How a Wish unfolds: the first one ("first") slowly enough to be understood
 * — each step held a beat longer — later ones ("repeat") at a practised
 * user's pace, each gesture starting as the previous one settles.
 */
type Pace = "first" | "repeat";

/**
 * The Wish popover's prompt editor — scoped to the popover: every tab the
 * session opened stays mounted (keep-alive), so the page holds other
 * editors (a conversation's composer, a page's blocks) and "the last
 * contenteditable" can be one of those, off screen; a click there closes the
 * popover.
 */
const wishPopover = (page: Page) =>
  page.getByRole("dialog").filter({ hasText: "Make a wish" });
const editorOf = (page: Page) =>
  wishPopover(page).locator('[contenteditable="true"]').first();

/**
 * A Wish, as a user makes it: the bar's Wish button — or, with `pick`, its
 * Pick UI element segment and a click on that element (the popover opens with
 * it as a chip, and the prompt starts on the next line) — the prompt typed one
 * character at a time (marks `typing` / `typed`), the "Auto-push and exit"
 * preprompt only when `autoPush`, then its submit ("Create task", or "Launch"
 * once a preprompt is set) — mark `submitted`. Then the pointer rests, if
 * `rest` says where.
 */
async function wish(
  r: Recorder,
  page: Page,
  prompt: string,
  opts: {
    /**
     * Where the hand rests once the task is filed (while the agent works) —
     * or none, when the next gesture follows at once: the hand goes there
     * straight from the submit button (a rest first was an out-and-back).
     */
    rest: { x: number; y: number } | null;
    /** The element to point at — picked whole, by a spot of its own box. */
    pick?: Locator;
    autoPush?: true;
    /** Suffix of its marks, for a segment holding several Wishes. */
    tag?: string;
    /** The first Wish of the film unfolds slower (default: a repeat). */
    pace?: Pace;
  },
): Promise<void> {
  const tag = opts.tag ?? "";
  const pace = opts.pace ?? "repeat";
  /** A step's settle: longer the first time the viewer sees it. */
  const beat = (first: number, repeat: number) =>
    r.hold(pace === "first" ? first : repeat);
  await openBar(r, pace);
  if (opts.pick) {
    // Found before picking starts (the picker's overlay then covers the page).
    const spot = await bareSpot(opts.pick);
    const picker = page.getByRole("button", { name: "Pick UI element" });
    await r.mark(`pick-button${tag}`, picker.first());
    await r.click(picker.first(), { duration: 0.3 });
    await r.mark(`picker-on${tag}`);
    // The camera pulls back while the hand still rests on the button (film:
    // pickPush) — never during the pick itself.
    await r.hold(0.9);
    // One gesture onto the element, a settle (the picker outlines it), the
    // click. Not slower: the action bar's leave grace ends the pick once the
    // hand is away from it for longer (a 1.1 s travel lost the pick).
    await r.move(spot, { duration: 0.75 });
    await r.mark(`picking${tag}`, opts.pick);
    await r.hold(0.3);
    await r.click(spot, { duration: 0.15 });
    await r.hold(0.25);
    const editor = editorOf(page);
    await r.click(
      { element: editor, at: { x: 0.97, y: 0.5 } },
      { duration: 0.4 },
    );
    await r.press("End");
    await r.press("Shift+Enter");
    await r.mark(`typing${tag}`, editor);
  } else {
    await r.click(page.getByRole("button", { name: "Wish", exact: true }), {
      duration: 0.3,
    });
    await beat(0.4, 0.15);
    const editor = editorOf(page);
    await r.click(
      { element: editor, at: { x: 0.5, y: 0.3 } },
      { duration: 0.35 },
    );
    await r.mark(`typing${tag}`, editor);
  }
  await r.type(prompt, { cps: 19 });
  await r.mark(`typed${tag}`);
  // The prompt read back once, the first time.
  await beat(0.6, 0.15);
  if (opts.autoPush) {
    await r.click(wishPopover(page).locator('button[aria-label="Preprompt"]'), {
      duration: 0.4,
    });
    await r.hold(0.15);
    await r.click(
      page.getByText("Auto-push and exit", { exact: true }).last(),
      {
        duration: 0.35,
      },
    );
    await r.hold(0.15);
  }
  // "Create task", or "Launch" once a launch option (the preprompt) is set.
  const create = wishPopover(page).getByRole("button", {
    name: /^(Create task|Launch)\b/,
  });
  await r.click(create.first(), { duration: pace === "first" ? 0.5 : 0.4 });
  await r.mark(`submitted${tag}`);
  if (opts.rest) await r.move(opts.rest, { duration: 0.7 });
}

/**
 * A point on `loc`'s own box that no descendant covers — where Pick UI
 * resolves to `loc` itself, the whole card or panel, rather than to a word
 * inside it (the picker picks the deepest element under the pointer). Scans
 * the box's edge band (its padding), nearest its vertical centre first.
 */
async function bareSpot(loc: Locator): Promise<{ x: number; y: number }> {
  const p = await loc.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const covered = (x: number, y: number): boolean => {
      const walk = (n: Element): boolean => {
        for (const c of Array.from(n.children)) {
          const st = getComputedStyle(c);
          if (st.display === "contents") {
            if (walk(c)) return true;
            continue;
          }
          if (st.display === "none" || st.visibility === "hidden") continue;
          // A decoration (an empty aria-hidden layer: a split row's hit-area)
          // is never what the picker selects (element-picker's resolveTarget).
          if (
            c.getAttribute("aria-hidden") === "true" &&
            c.childElementCount === 0 &&
            (c.textContent ?? "").trim() === ""
          )
            continue;
          for (const b of Array.from(c.getClientRects()))
            if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)
              return true;
        }
        return false;
      };
      return walk(el);
    };
    const hit = (x: number, y: number): boolean => {
      const top = document.elementFromPoint(x, y);
      return top !== null && (top === el || el.contains(top)) && !covered(x, y);
    };
    const ys: number[] = [];
    for (let d = 0; d <= r.height / 2 - 3; d += 3)
      ys.push(r.top + r.height / 2 - d, r.top + r.height / 2 + d);
    // Right padding first (where a hand naturally rests on a card), then left.
    for (const x of [r.right - 4, r.right - 8, r.left + 4, r.left + 8])
      for (const y of ys) if (hit(x, y)) return { x, y };
    for (let x = r.right - 4; x > r.left; x -= 6)
      for (const y of ys) if (hit(x, y)) return { x, y };
    return null;
  });
  if (!p)
    throw new Error(
      `promo-film: ${String(loc)} has no bare spot to pick it by`,
    );
  return p;
}

/** Keep recording (the page's time running) until `loc` is visible, at most `max` seconds. */
async function holdUntil(
  r: Recorder,
  loc: Locator,
  max: number,
): Promise<void> {
  // Frame by frame: the caller marks the very frame it appears in.
  for (let waited = 0; ; waited += 1 / 60) {
    if (await loc.first().isVisible()) return;
    if (waited > max)
      throw new Error(`promo-film: ${String(loc)} never appeared (${max} s)`);
    await r.hold(1 / 60);
  }
}

/** Keep recording until `loc` is no longer visible, at most `max` seconds. */
async function holdUntilGone(
  r: Recorder,
  loc: Locator,
  max: number,
): Promise<void> {
  for (let waited = 0; ; waited += 1 / 60) {
    if (!(await loc.first().isVisible())) return;
    if (waited > max)
      throw new Error(`promo-film: ${String(loc)} never went away (${max} s)`);
    await r.hold(1 / 60);
  }
}

/**
 * The app launcher's grid (hovering the app's own icon) → the app `rowKey`,
 * and on in the same movement to `then` — what the hand goes for next in the
 * app, so it never rests on whatever the opened app draws under the icon it
 * clicked (a sidebar row, lit by the hover).
 */
async function viaLauncher(
  r: Recorder,
  page: Page,
  rowKey: string,
  mark: string,
  then: RecTarget,
): Promise<void> {
  const launcher = page.locator('button[aria-label="All apps"]').first();
  // Its duration by distance (the recorder's default): from across the
  // screen a fixed 0.6 s was a ~125 px-a-frame flick.
  await r.move(launcher);
  await r.hold(0.4);
  const icon = page.locator(`[role="button"][data-row-key="${rowKey}"]`);
  await r.mark(`${mark}-grid`, icon.first());
  await r.click(icon.first(), { duration: 0.4 });
  await r.mark(mark);
  // By distance (the recorder's default): a fixed 0.7 s across the screen
  // was a flick.
  await r.move(then);
}

/**
 * The app launcher → Home: Home is the launcher's own click (the app's mark,
 * top-left), pressed as the hand arrives — before its hover-intent delay
 * (120 ms) could open the grid of other apps, so the grid never shows (going
 * down the grid to its "All apps" line was a detour). Then the hand goes on
 * in the same movement to `then`, out of the floating launcher's corner zone.
 */
async function homeViaLauncher(
  r: Recorder,
  page: Page,
  /** Where the hand goes on to, in the same movement (see viaLauncher). */
  then: RecTarget,
): Promise<void> {
  const launcher = page.locator('button[aria-label="All apps"]').first();
  // Watched from here to the press: the grid must not open on any frame.
  await page.evaluate(() => {
    const w = window as unknown as { __filmGridSeen?: boolean };
    w.__filmGridSeen = false;
    const seen = () =>
      document.querySelector('[aria-label="Apps"]:not(button)') !== null;
    const obs = new MutationObserver(() => {
      if (!seen()) return;
      w.__filmGridSeen = true;
      obs.disconnect();
    });
    obs.observe(document.body, { subtree: true, childList: true });
    // Up to the press: the click itself closes it (and Home mounts after).
    addEventListener("pointerdown", () => obs.disconnect(), {
      capture: true,
      once: true,
    });
  });
  // The pointer is over the button for the minimum-jerk reach's last ~11 %
  // (~0.09 s of 0.8 s from across the screen), then one frame's press: the
  // click lands inside the 120 ms intent. 0.8 s for ~1200 px is a brisk
  // reach, not a flick (the default by distance would be 0.95 s, and with
  // it the pointer sat on the button past the intent).
  await r.click(launcher, { duration: 0.8, dwell: 0, press: 1 / 60 });
  await r.mark("home");
  if (
    await page.evaluate(
      () => (window as unknown as { __filmGridSeen?: boolean }).__filmGridSeen,
    )
  )
    throw new Error(
      "promo-film: the launcher's grid opened on the way to Home — the click must land within its hover intent",
    );
  await r.move(then);
}

/**
 * A Pages sidebar tree row, by its page's id — the whole row (its title sits
 * in a box-less `display: contents` cell wrapper, which has no box to aim at).
 */
const sidebarPage = (page: Page, pageId: string) =>
  page
    .locator(
      `[data-ui-owner^="PagesSidebar"] [role="row"][data-row-key="${pageId}"]`,
    )
    .first();

// ------------------------------------------------------------------------

/** A map's remembered view, as the map stores the place the user left it. */
async function rememberMapView(
  page: Page,
  key: string,
  view: { center: { lat: number; lng: number }; zoom: number },
): Promise<void> {
  await page.evaluate(
    ([k, v]) =>
      localStorage.setItem(
        `s:map.camera:${k}`,
        JSON.stringify({ v, ts: Date.now() }),
      ),
    [key, view] as const,
  );
}

/**
 * Places as this user left it (in the browser's own storage, so set again in
 * every fresh session that shows it): the map last looked at over Paris, the
 * panel in Gallery view (cards with photos).
 */
async function placesAsLeft(page: Page): Promise<void> {
  await open(page, "/home");
  await rememberMapView(page, "places.map", {
    center: { lat: 48.862, lng: 2.345 },
    zoom: 13,
  });
  await open(page, "/places", { settleMs: 4000 });
  await page.locator('button[data-tooltip="Gallery"]').first().click();
  await page.waitForTimeout(1500);
}

/** A block of the page being edited, by its id. */
const blockEl = (page: Page, id: string) =>
  page.locator(`[data-block-id="${id}"]`).first();

/**
 * The camera of the `pages` write — the approved prototype's two motions
 * (proto-1794145785-ej5bjg `?motion=`): `single` (one follow move) or
 * `staged` (a framing move, then the follow).
 */
const PAGES_CAMERA = "single" as "single" | "staged";

/**
 * The page clock's rate while the agent's shops arrive (record's
 * `clockRate`): the app's arrival reads a little fast at real speed in the
 * film, so it is filmed at 0.7× — its 525 ms opening seen over ~750 ms.
 */
const PAGES_ARRIVAL_RATE = 0.7;

/**
 * Where the hand rests on the gallery as the film opens (CSS px of the
 * film's screen) — and where it comes to rest at the end, on the same
 * gallery, framed as it was ({@link GALLERY_REST}).
 */
const OPENING_HAND = { x: 700, y: 610 } as const;

const pages: SegmentFn = async ({ h }) => {
  const page = await session(h);
  await open(page, `/pages/page/${FILM_PAGES_OPENED.buying}`);
  // The user's page as they left it: a sentence, the heading "Shops", their
  // list — each shop with its place — then the heading "Questions to ask"
  // and its three bullets.
  await visible(blockEl(page, PIANO_SHOP_LIST[0]!.todo));
  const asSeeded = 2 + 2 * PIANO_SHOP_LIST.length + 4;
  if ((await page.locator("[data-block-id]").count()) !== asSeeded)
    throw new Error(
      "promo-film pages: the Buying a piano page is not as the seed wrote it (the agent's shops already added?) — re-seed first",
    );
  await placesAsLeft(page);
  // The sidebar as this user keeps it: the Music section open (the
  // browser's own view state, so set again in every fresh session).
  await page.evaluate(
    (music) =>
      localStorage.setItem(
        "pages-sidebar:view-state",
        JSON.stringify({ pages: { expanded: { [music]: true } } }),
      ),
    FILM_PAGES_OPENED.music,
  );
  await open(page, "/home");
  const pagesTile = page.locator('[role="button"][data-row-key="pages"]');
  await visible(pagesTile);
  return rec(page, "pages", OPENING_HAND, async (r) => {
    await r.hold(0.4);
    await r.mark("home-click", pagesTile);
    await r.click(pagesTile, { duration: 0.6 });
    // The next gesture starts as Pages opens — the hand never rests on the
    // sidebar row it lands over (a hover left lit).
    await r.click(sidebarPage(page, FILM_PAGES_OPENED.buying), {
      duration: 0.7,
    });
    await r.mark("buying");
    // The user's own short page, read on the way to its header: the hand
    // drifts slowly up to the page-type menu while the eye reads — a reading
    // beat with a purpose, never a still pause.
    await r.hold(0.5);
    const kind = page.getByRole("button", { name: "Page kind: Page" });
    await r.click(kind.first(), { duration: 1.5, dwell: 0.2 });
    await r.mark("kind-menu");
    // One gesture on from the trigger to "Agent page" as the menu opens
    // under the hand — its kinds read on the way, never a stop before it.
    await r.hold(0.15);
    await r.click(page.getByText("Agent page", { exact: true }).last(), {
      duration: 0.6,
    });
    // The pill turns to Agent page (the server's answer, live).
    await holdUntil(
      r,
      page.getByRole("button", { name: "Page kind: Agent page" }),
      4,
    );
    await r.mark("agent-page");
    // One open surface at a time: the menu is dismissed before the Wish
    // opens its popover — by Escape (the pill keeps no focus ring after it:
    // the menu returns focus without a keyboard ring).
    await r.hold(0.3);
    await r.press("Escape");
    await r.mark("kind-closed");
    await holdUntilGone(
      r,
      page.getByText("Agents may write anywhere on it."),
      2,
    );
    await r.hold(0.2);
    // The pointer rests right of the page's text while the agent writes:
    // nothing it hovers changes.
    await wish(r, page, PROMPTS.shops, {
      rest: { x: 1150, y: 560 },
      pace: "first",
    });
    // No time-lapse: the agent completes the list live in ONE edit_page —
    // more shops, each in the user's own form with its place, a blank line,
    // then a map of them — which the open page receives as one push. The
    // camera is the film's: the page never scrolls on its own. Staged as the
    // approved prototype (proto-1794145785-ej5bjg), in one of its two
    // motions (`PAGES_CAMERA`): `staged` — move 1 frames the room the shops
    // open into as the write lands, move 2 follows the arrival down;
    // `single` — the write lands where the camera already is, and ONE move
    // follows. The follow starts once the first shop is in (opaque, settled)
    // and lands with the map centred. Each move ease-in-out (at rest at both ends: the
    // velocity is continuous), two beats at 172 BPM.
    await r.mark("writing");
    const CAM = { duration: 0.698, easing: "inOutQuad" } as const;
    const last = PIANO_SHOP_LIST[PIANO_SHOP_LIST.length - 1]!;
    const lastTodo = blockEl(page, last.todo);
    const camera = r.watchScroll(lastTodo);
    // Slow motion, the film's only: from just before the write lands until
    // the map has settled, the page's clock runs at PAGES_ARRIVAL_RATE — the
    // blocks' arrival, the camera and everything on the page slowed together,
    // still one frame per 1/60 s (the app's own arrival is unchanged). Eased
    // in over this beat.
    r.clockRate(PAGES_ARRIVAL_RATE, { over: 0.17 });
    await r.hold(0.17);
    if (PAGES_CAMERA === "staged") {
      // Move 1: the shops' room centred — its height read off the user's own
      // shop (a to-do and its place) for each added one, plus the blank line.
      const todo = await r.settledRect(lastTodo);
      const place = await r.settledRect(blockEl(page, last.place));
      const roomTop = place.y + place.height;
      const room = PIANO_SHOPS_ADDED.length * (roomTop - todo.y) + todo.height;
      const s1 = todo.scroller;
      await r.scrollTo(
        lastTodo,
        Math.min(
          s1.maxScrollTop,
          Math.max(
            s1.scrollTop,
            s1.scrollTop + roomTop + room / 2 - (s1.top + s1.height / 2),
          ),
        ),
        CAM,
      );
    }
    // The write lands (the page's clock stands still while it is made) — in
    // `staged`, as move 1 comes to rest.
    const written = (await post(page, writeFilmShops, {})) as
      { createdIds?: unknown } | undefined;
    const createdIds = written?.createdIds;
    if (
      !Array.isArray(createdIds) ||
      createdIds.length === 0 ||
      !createdIds.every((id) => typeof id === "string")
    )
      throw new Error("promo-film pages: the agent's edit created no block");
    // The first shop, in page order: its to-do and the place under it (the
    // union locator lists the new blocks in document order).
    const created = page.locator(
      createdIds.map((id) => `[data-block-id="${id}"]`).join(", "),
    );
    const firstShop = [created.nth(0), created.nth(1)];
    // The write's push reaches the page a few frames later: the film runs on
    // while it does, until the first shop's blocks are in the DOM.
    for (let i = 0; (await created.count()) < 2; i++) {
      if (i >= 120)
        throw new Error(
          "promo-film pages: the agent's first shop reached no block within 2 s of the write",
        );
      await r.hold(1 / 60);
    }
    // Where each settles once the arrival is over — the camera has not moved
    // yet, so it is the box it will hold until the follow starts.
    const firstShopAt = [
      await r.settledRect(firstShop[0]!),
      await r.settledRect(firstShop[1]!),
    ];
    // In: fully opaque (its own entry and every ancestor's) and at its
    // settled box — read off the screen, so a longer or slower cascade moves
    // the camera's start with it.
    const isIn = async (): Promise<boolean> => {
      for (const [i, b] of firstShop.entries()) {
        const at = firstShopAt[i]!;
        const ok = await b.evaluateAll(
          (els, want) => {
            const el = els[0];
            if (!el) return false;
            let o = 1;
            for (let e: Element | null = el; e; e = e.parentElement)
              o *= Number(getComputedStyle(e).opacity);
            const box = el.getBoundingClientRect();
            return (
              o > 0.99 &&
              Math.abs(box.y - want.y) < 0.5 &&
              Math.abs(box.height - want.height) < 0.5
            );
          },
          { y: at.y, height: at.height },
        );
        if (!ok) return false;
      }
      return true;
    };
    for (let i = 0; !(await isIn()); i++) {
      if (i >= 300)
        throw new Error(
          "promo-film pages: the agent's first shop was not in (opaque, at its settled box) within 5 s of the write",
        );
      await r.hold(1 / 60);
    }
    await r.mark("first-shop-in", firstShop[0]!);
    // The follow: from the first shop in (the eye has read it arrive) to the
    // map centred, as it will be once the arrival has settled. (The block's marker draws no box: the
    // map is its child.)
    const map = page
      .locator('[data-contribution-id="page.map:map"] > *')
      .first();
    const final = await r.settledRect(map);
    const s2 = final.scroller;
    const cam2 =
      s2.scrollTop + final.y + final.height / 2 - (s2.top + s2.height / 2);
    if (cam2 > s2.maxScrollTop + 0.5)
      throw new Error(
        `promo-film pages: no room below the map to centre it (${Math.round(cam2 - s2.maxScrollTop)} px short)`,
      );
    await r.scrollTo(lastTodo, cam2, CAM);
    camera.stop();
    await r.mark("written");
    // At rest: the map where it was measured to settle, centred.
    const landed = await map.boundingBox();
    const centre = landed && landed.y + landed.height / 2;
    if (
      !landed ||
      Math.abs(landed.y - final.y + (cam2 - s2.scrollTop)) > 1 ||
      Math.abs(centre! - (s2.top + s2.height / 2)) > 4
    )
      throw new Error(
        `promo-film pages: the map is not centred at rest (${landed ? `${Math.round(landed.y)}+${Math.round(landed.height)}, the scroller's centre at ${Math.round(s2.top + s2.height / 2)}` : "no box"})`,
      );
    await r.mark("map", map);
    // Back to real speed as the payoff holds: the list completed and its
    // map, held to land.
    r.clockRate(1, { over: 0.4 });
    await r.hold(1.0);
    // The map's own expand (revealed as the hand comes over the map) — one
    // gesture onto it → Places grows out of the map, the page's places laid
    // over the user's map.
    await r.click(page.locator('button[aria-label="Open in Places"]').first(), {
      duration: 0.8,
      dwell: 0.2,
    });
    await r.mark("places");
    // Places grows out of the map, and the scene goes on in it: the same
    // live map, never a second page load (a join here re-laid the map's
    // labels — the whole-map flash after Places opened).
    await r.hold(1.6);
    await placesScene(r, page);
    endHere("pages", page);
  });
};

/**
 * The Places side panel's place cards (its DataView's rows), in panel order:
 * the innermost keyed box — the whole card (the list wraps each row in an
 * outer div carrying the same key).
 */
const placeCards = (page: Page) =>
  page
    .locator("[data-row-key]:not(:has([data-row-key]))")
    .filter({ has: page.locator("img") });

/**
 * Places, as it grew out of the page's map (the same recording as `pages`):
 * a shop's detail → its photos → back out → the opening-times Wish → the
 * launcher → Files.
 */
async function placesScene(r: Recorder, page: Page): Promise<void> {
  const cards = placeCards(page);
  await r.hold(0.3);
  // The hand starts over the second shop's card (where the map's expand
  // left it: its pin lit). On down the list, unhurried, over the third —
  // its pin lights on the map as the hand passes — to the fourth.
  // One shop, a closer look: its card drills into the panel, and straight
  // on into its photos (the header photo opens the card's photo grid) —
  // then back out the same way, briskly.
  await r.click(cards.nth(3), { duration: 1.3, dwell: 0.2 });
  await r.mark("detail");
  await r.hold(0.3);
  // The hero strip's photo (its first, the one showing).
  const hero = page.locator("img.cursor-zoom-in").first();
  await r.click({ element: hero, at: { x: 0.5, y: 0.45 } }, { duration: 0.45 });
  // "Photos · <place> · N from Google": the card widens into the grid.
  await holdUntil(r, page.getByText(/ · \d+ from Google$/), 3);
  await r.mark("photos");
  // A glance at the grid — a passing step, not a payoff.
  await r.hold(0.6);
  await r.click(
    page.getByRole("button", { name: "Back", exact: true }).first(),
    {
      duration: 0.45,
    },
  );
  await r.hold(0.2);
  await r.click(
    // The drilled card's Back line: "<list> · 2 of 4" (a page's places)
    // or "<preset> · in view" / "· all".
    page.getByRole("button", { name: /·\s*(\d+ of \d+|in view|all)$/ }).first(),
    { duration: 0.45 },
  );
  await r.mark("list");
  await r.hold(0.2);
  // A Wish about the cards, pointing at one — the whole card.
  await wish(r, page, PROMPTS.hours, {
    rest: { x: 1080, y: 560 },
    pick: cards.first(),
    autoPush: true,
    tag: "-hours",
  });
  // Time-lapse: the agent turns the opening times on — the place-cards
  // setting, through the Config pane's own write.
  await r.mark("lapse");
  // The agent at work: seconds of real time, a second and a half of film.
  await r.hold(6.0);
  await post(page, setConfigField, PLACES_HOURS_CONFIG);
  // The card's hours line: "Open · 10:00–19:00" or "Closed today".
  const hours = cards.first().getByText(/^(Open · |Closed today)/);
  await holdUntil(r, hours, 6);
  await r.mark("lapsed");
  // The payoff is the shops open this afternoon: the film's calendar (the
  // seed's film-clock) is a day they all open — loud if one says closed.
  const closed = await cards.getByText(/^Closed today/).count();
  if (closed > 0)
    throw new Error(
      `promo-film places: ${closed} card(s) read "Closed today" on the film's calendar — set it on a day every shop opens (seed core's FILM_WEEKDAYS)`,
    );
  // The hours ease in: the card's box once they have.
  await r.hold(0.8);
  await r.mark("hours", cards.first());
  await r.hold(1.6);
  // On to the music: the launcher → Files.
  // On, in the same movement, to the scores folder's disclosure — the
  // next segment's first click.
  await viaLauncher(
    r,
    page,
    "file-explorer",
    "files",
    fileRow(page, "scores").getByRole("button", { name: "Expand" }),
  );
  // Files opening (the next segment goes on as it settles).
  await r.hold(0.3);
}

/** A Files tree row, by the name it shows. */
const fileRow = (page: Page, name: string) =>
  page.locator("[data-tree-row]").filter({ hasText: name }).first();

/**
 * Unfold folder `name` in the Files tree: hover its row, its own Expand.
 * `arrived`: the hand is already on that Expand (the gesture that brought it
 * there ended the segment before), so the press follows at once — the
 * click's own beat, no second reach on the spot.
 */
async function unfold(
  r: Recorder,
  page: Page,
  name: string,
  o: { arrived?: true } = {},
): Promise<void> {
  const row = fileRow(page, name);
  // One gesture straight onto the row's Expand control (the folder's icon at
  // rest, its chevron once hovered), then the click there — never a stop
  // elsewhere on the row and a dart to it.
  await r.click(row.getByRole("button", { name: "Expand" }), {
    duration: o.arrived ? 0.05 : 0.6,
  });
  await r.hold(0.35);
}

/**
 * A row of Sonata's song panel, by the section contributed there: its header
 * row (the box holding the section's disclosure control) — the whole row the
 * user points at. Addressed by the slot contribution's id, which the element
 * picker stamps (it is in the composition whenever Pick UI is).
 */
const songPanelRow = (page: Page, contributionId: string): Locator =>
  page
    .locator(
      `[data-contribution-id="${contributionId}"] :has(> button[aria-expanded])`,
    )
    .first();

/**
 * Where the hand rests on Sonata's Song panel while the song plays: the
 * panel's empty room below its rows (none lit by the hover), well clear of
 * the top bar's hover zone.
 */
const SONG_PANEL_REST = { x: 1080, y: 520 } as const;

/**
 * Files → Sonata, and the Wishes made there: ONE recording, so the song plays
 * on from the Open in Sonata click without a seam (a segment joint would
 * restart its playback in a fresh session).
 */
const sonata: SegmentFn = async ({ h }) => {
  const from = continueFrom("pages");
  const page = await session(h);
  await open(page, from.path, { settleMs: 3000 });
  await visible(fileRow(page, "scores"));
  return rec(page, "sonata", from.cursor, async (r) => {
    // A score first: its page as a picture. The hand arrived on the scores
    // folder's Expand as `pages` ended (the launcher gesture carried it
    // there, Files settling under it): the press is the same gesture.
    await unfold(r, page, "scores", { arrived: true });
    await r.click(fileRow(page, SCORE_IMAGE), { duration: 0.5 });
    await r.mark("score");
    // A reading beat: the page as a picture, then on to the music.
    await r.hold(0.9);
    // Then the music: the MIDI's own preview, playing.
    await unfold(r, page, "music");
    await r.click(fileRow(page, MIDI), { duration: 0.5 });
    await r.mark("midi");
    await r.hold(1.6);
    const openIn = page.getByRole("button", { name: "Open in Sonata" }).first();
    await r.move(openIn, { duration: 0.6 });
    await r.hold(0.2);
    await r.click(openIn, { duration: 0.15 });
    await r.mark("sonata");
    // Sonata grows out of the button, the song playing on — and the hand
    // goes on in the same movement down to the Song panel it reads next (the
    // bare room below its rows, lighting none): left on the button, it rests
    // in the full-screen app's top bar, whose hover reveals the floating
    // action bar under it — the bar opens only when the hand goes for it
    // (the Wish below).
    await r.move(SONG_PANEL_REST);
    await r.hold(1.8);
    // The Wish, pointing at a row of the song panel — Feel, the row the new
    // section goes under ("a section below").
    await wish(r, page, PROMPTS.key, {
      rest: { x: 1080, y: 600 },
      pick: songPanelRow(page, "apps.sonata.rich.swing:feel"),
      autoPush: true,
    });
    // Time-lapse: the agent shows the section — the layout's own `hidden`
    // flag, reset through the Config pane's write. It animates in.
    await r.mark("lapse");
    // The agent at work: seconds of real time, a second and a half of film.
    await r.hold(6.0);
    await post(page, resetConfigField, {
      storePath: SONATA_SECTION_LAYOUT,
      key: "items",
    });
    const keyRow = page.getByText("Current key", { exact: true });
    await holdUntil(r, keyRow, 6);
    // The frame it appears in: the highlight starts here.
    await r.mark("lapsed");
    await r.mark("section-appears");
    // Its row once it has eased in: what the highlight frames.
    await r.hold(0.7);
    // The whole section as it appears (its header and its body): the
    // largest box around its label that holds no other section's (the
    // panel's sections are siblings; "Circle of fifths" is one of them).
    const keySection = await keyRow.first().evaluate((label) => {
      let el: Element = label;
      // The last box on the way up (a wrapper may draw none: display contents).
      let boxed: Element = label;
      while (
        el.parentElement &&
        !(el.parentElement.textContent ?? "").includes("Circle of fifths")
      ) {
        el = el.parentElement;
        if (el.getBoundingClientRect().height > 0) boxed = el;
      }
      if (!el.parentElement)
        throw new Error("promo-film sonata: Current key is not in the panel");
      const r = boxed.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await r.mark("section", keySection);
    // The payoff held, then the new section opened: the song's key.
    await r.hold(1.2);
    await r.click(keyRow.first(), { duration: 0.6 });
    await r.mark("key-open");
    await r.hold(1.6);
    // Read, then folded again by its own header — the hand is still on it —
    // before the next request: the panel back as it was, the new section
    // in it.
    await r.click(keyRow.first(), { duration: 0.25 });
    await holdUntil(
      r,
      page.locator(
        `[data-contribution-id="${SONATA_KEY_SECTION}"] button[aria-expanded="false"]`,
      ),
      2,
    );
    await r.mark("key-closed");
    await r.hold(0.45);
    // Create any app: a Wish for a new one, from here — and once it is
    // filed, the hand goes straight on to the launcher (no rest between).
    await wish(r, page, PROMPTS.create, {
      rest: null,
      tag: "-create",
    });
    // No time-lapse: the user goes to see the agent at work.
    await post(page, finishFilmAgentRun, {
      prompt: PROMPTS.create,
      // Finished now, on the page's (the film's) calendar.
      now: await page.evaluate(() => Date.now()),
    });
    const conv = page.getByText("Circle — a P2P messaging app").first();
    await viaLauncher(r, page, "agent-manager", "agent-manager", conv);
    await r.click(conv, { duration: 0.2 });
    await r.mark("conversation");
    // Its answer, the prototype it made right there: read, then opened.
    await r.hold(1.6);
    endHere("sonata", page);
  });
};

const prototype: SegmentFn = async ({ h }) => {
  const from = continueFrom("sonata");
  const page = await session(h);
  await open(page, from.path, { settleMs: 3500 });
  const chip = page.locator("button", { hasText: "Circle — P2P friends" });
  await visible(chip);
  return rec(page, "prototype", from.cursor, async (r) => {
    await r.hold(0.2);
    await r.click(chip.last(), { duration: 0.6 });
    await r.mark("proto-pane");
    await r.hold(1.2);
    await r.click(
      page.locator('button[aria-label="Open in Prototypes"]').first(),
      { duration: 0.5 },
    );
    await r.mark("prototypes");
    await r.hold(1.0);
    // The flow: a second frame first, its variant (Light), then the two
    // sizes — Phone, then back to the desktop's (This window) — and the
    // slider there, across the two variants laid out wide.
    // The add-frame rail shows while the pointer is over the frame: it sits
    // on the frame's right border line, below the hand (on Expand, above the
    // frame's right end), so ONE straight gesture down to it — bowed a touch
    // inwards, over the frame — reveals it on the way, with a beat on it for
    // the rail to show before the press. (A detour through the frame's
    // middle was a dive and a ricochet.)
    const add = page.locator('button[aria-label="Add a frame to compare"]');
    await r.click(add.first(), { duration: 0.75, dwell: 0.2 });
    await r.mark("pair");
    await r.hold(0.4);
    // The second frame's options: its Theme → Light.
    const options = page.locator('button[aria-label="Prototype options"]');
    await r.click(options.nth(1), { duration: 0.6 });
    await r.hold(0.35);
    await r.click(page.getByRole("radio", { name: "Light", exact: true }), {
      duration: 0.5,
    });
    await r.hold(0.25);
    // Closed by a click on its own button, as a hand does, and straight on —
    // the hand never rests on it long enough for its tooltip.
    await r.click(options.nth(1), { duration: 0.3 });
    await r.click(page.getByRole("button", { name: "Phone", exact: true }), {
      duration: 0.7,
    });
    await r.mark("phones");
    await r.hold(0.6);
    // Back to the desktop's ratio: the size this window gives a page.
    await r.click(
      page.getByRole("button", { name: "This window", exact: true }),
      {
        duration: 0.5,
      },
    );
    await r.mark("desktop-size");
    await r.hold(0.5);
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
    // Performed as an animator would (the recorder's `performed` profile:
    // slow in, slow out a little past the mark, a gentle settle back, the
    // hand's slight waver): a decisive sweep to reveal most of the light
    // variant, a beat to read it, then a slower sweep across to the dark one,
    // ending there, settled — both variants have been seen, so no trip back
    // to the middle.
    await r.drag({ x: hx, y: hy }, at(0.15), {
      duration: 0.95,
      profile: "performed",
    });
    await r.hold(0.4);
    await r.drag(at(0.15), at(0.85), { duration: 1.7, profile: "performed" });
    await r.mark("swiped");
    await r.hold(0.3);
    // The next step: build it.
    await wish(r, page, PROMPTS.implement, { rest: { x: 1100, y: 600 } });
    await r.mark("lapse");
    await r.hold(8.0);
    await r.mark("lapsed");
    // The hand only drifts off the corner — out of the floating launcher's
    // 96 px reveal zone, staying up by the title (no move down the screen),
    // over nothing it would light.
    await homeViaLauncher(r, page, { x: 170, y: 120 });
    await r.hold(0.3);
    // The app the agent built arrives: Circle's tile, live in the gallery
    // right after Browser (the app layout's own `hidden` flag the seed set,
    // dropped through the Config pane's write).
    await showCircle(page);
    const tile = page.locator('[role="button"][data-row-key="circle"]');
    await holdUntil(r, tile, 6);
    await r.mark("circle-tile", tile.first());
    // The gallery with its new app: the desktop pull-back starts from here.
    await r.hold(3.0);
  });
};

/**
 * The desktop's screen: 1.5× the film's in CSS px — a roomier desktop whose
 * windows still read (at 2× the room, v6's, they were too small). At 1.5 px
 * per CSS px (2880×1620): the film ends pushed in 1.5× on its full-screen
 * gallery (film.ts, `gallery-frame`), where a CSS px fills 1.5 output px of
 * the 1080p film — so the landing is drawn 1:1, as sharp as the opening
 * (at 4/3, v21's, it was upscaled 1.125×).
 */
export const DESK = { width: 1920, height: 1080, dpr: 1.5 } as const;

/**
 * Home's window content (CSS px): narrower and shorter than the film's
 * screen, still holding the whole gallery as it lies full screen — its
 * seven columns (872 px plus the grid's padding: at 960 it reflows to six
 * and pushes Circle and New app to a third row, off the window), its two
 * rows ending ~550 px down.
 */
const HOME_CONTENT = { width: 1000, height: 600 } as const;

/**
 * A prototype as the app it mocks: the Prototypes app's present page
 * (`present/<id>/live/responsive`, `apps/prototypes/present`) — the live
 * frame alone, laid out at the window's own size, with none of the viewer's
 * chrome (its tag, size chip and rail show only on hover).
 */
const presented = (id: string) => () =>
  `/prototypes/present/${id}/live/responsive`;

/**
 * The apps the closing montage opens, one window each, in this order, and
 * where each lands — a desktop someone arranged, not a grid: varied sizes
 * overlapping in depth, asymmetric, each new window landing on top of the
 * earlier ones, the focal window (the Agent Manager, where the film began)
 * opened last, on top. `at` is the window's outer box in CSS px of the work
 * area (the screen above the shelf, ~1920 × 1000).
 *
 * **New apps first**: the apps the film has not shown yet (Deploy, Jukebox,
 * Bundled Mail, Bridge Trainer, Family Recipes, Tap Tap Party, Chord) open
 * first — the readable beats land on them — then the ones the viewer already
 * met (Pages, Places, Files, Sonata, Circle), then the Agent Manager.
 *
 * **Every window gives its app room to breathe** (the Principles): each size
 * is the one where that app's own layout is comfortable — checked one by one
 * at that size (Pages' three cards on one line and its recent list whole,
 * Sonata's four library cards on one row, Chord's single column with its
 * piano, Places' map between its two panels, Circle's sidebar beside its
 * conversation, the Deploy site's two columns — Traffic beside Messages, as
 * from ~1130 px; a prototype presented as its app, its own layout at the
 * window's size). **Natural proportions**: every window is landscape, near
 * 16:10 (1.6) — Chord a little taller (1.48: one column, under its 1000 px
 * container breakpoint, down to its piano). Never near-square, never a thin
 * strip. Thirteen apps do not fit side by side at those sizes, so they
 * overlap — never shrink an app to fit.
 *
 * **Composed like a photograph**: the cluster keeps a margin of wallpaper on
 * every side, the earlier windows peek out around the focal one in depth —
 * Pages top-left, Sonata and Chord above, Places below right, Files and the
 * light Circle bottom-left as a counterweight — and the Agent Manager, last
 * and on top, sits right of centre, its centre on the right third. Home is
 * already open, under them.
 *
 * **Opening a window**: the shelf's launcher, the app's name, Enter. An
 * entry with a `route` opens a NEW window (Shift+Enter) and shows that route
 * in it — the way a link opens one: the page's URL changes and the focused
 * window's tab follows it (the tab set's own URL reconcile). Deploy is a
 * developer app the launcher does not list to this user, so its window is a
 * new one routed to its site; a prototype is a new Prototypes window routed
 * to its present page ({@link presented}).
 */
export const MONTAGE: readonly {
  /** What is typed into the launcher. */
  app: string;
  /** Shown in a new window of `app`, then routed here (an app route, no `/desktop` prefix). */
  route?: (ids: MontageIds) => string;
  /**
   * Keys pressed in the window once it is placed: an app that shows nothing
   * until it is used (Tap Tap Party's stage) shows what it does.
   */
  keys?: string;
  at: { x: number; y: number; width: number; height: number };
}[] = [
  // Two columns from ~1130 px: Traffic beside Messages and Deployments.
  {
    app: "Home",
    route: ({ deploySite }) => `/deploy/site/${deploySite}`,
    at: { x: 560, y: 40, width: 1200, height: 750 },
  },
  // Jukebox (the bookmarked songs as a music app): sidebar and stations.
  {
    app: "Prototypes",
    route: presented("proto-1792801597-cohp0r"),
    at: { x: 380, y: 120, width: 1120, height: 700 },
  },
  // Bundled Mail.
  {
    app: "Prototypes",
    route: presented("proto-1790119804-gjtv"),
    at: { x: 70, y: 230, width: 1120, height: 700 },
  },
  // Bridge Trainer: the table, the bidding box, the score card and the hand.
  {
    app: "Prototypes",
    route: presented("proto-1792094916-a1xqcb"),
    at: { x: 150, y: 40, width: 1200, height: 750 },
  },
  // Family Recipes: two rows of four photo cards.
  {
    app: "Prototypes",
    route: presented("proto-1794092194-mfppco"),
    at: { x: 760, y: 300, width: 1040, height: 650 },
  },
  {
    app: "Tap Tap Party",
    keys: "w",
    at: { x: 1140, y: 90, width: 720, height: 450 },
  },
  // One column (under the trainer's 1000 px container breakpoint, which
  // splits it into two squeezed ones), down to the end of the piano.
  { app: "Chord", at: { x: 880, y: 40, width: 990, height: 670 } },
  { app: "Pages", at: { x: 96, y: 64, width: 1040, height: 650 } },
  { app: "Places", at: { x: 600, y: 262, width: 1140, height: 712 } },
  { app: "Files", at: { x: 120, y: 360, width: 880, height: 550 } },
  // Wide enough for the library's four cards on one row.
  { app: "Sonata", at: { x: 660, y: 48, width: 1080, height: 676 } },
  { app: "Circle", at: { x: 250, y: 420, width: 880, height: 550 } },
  // The focal window: its centre on the right third.
  { app: "Agent Manager", at: { x: 690, y: 200, width: 1120, height: 700 } },
];

/** Ids a montage route names, read off the seeded instance before recording. */
interface MontageIds {
  /** The seeded Deploy site (a `dpl-…` id, minted by the seed). */
  deploySite: string;
}

/**
 * Show `route` in the focused window, the way a link opens it: the page's
 * URL changes and the tab set reconciles its focused tab to the app that
 * owns it (a `{}` history entry is re-read from the URL), in place.
 */
async function routeFocusedWindow(page: Page, route: string): Promise<void> {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, `/desktop${route}`);
}

/** The seeded Deploy site's id: Deploy's overview → its one site card → the URL it opens. */
async function seededDeploySite(page: Page): Promise<string> {
  await open(page, "/deploy", { settleMs: 2500 });
  await page.getByText("piano-notes.example.com").last().click();
  await page.waitForURL(/\/deploy\/site\/dpl-/, { timeout: 15_000 });
  const id = /\/site\/(dpl-[^/?#]+)/.exec(page.url())?.[1];
  if (!id)
    throw new Error(`promo-film desktop: no Deploy site in ${page.url()}`);
  return id;
}

/** Every desktop window on screen now: remembered, so the next one opened is the one not among them. */
async function markWindows(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const w of Array.from(
      document.querySelectorAll('[data-ui-owner^="TabContainer"]'),
    ))
      w.setAttribute("data-film-seen", "");
  });
}

/** The one window opened since {@link markWindows}, tagged `data-film=<tag>` for a stable locator. */
async function tagNewWindow(page: Page, tag: string): Promise<Locator> {
  await page.evaluate((t) => {
    const fresh = Array.from(
      document.querySelectorAll('[data-ui-owner^="TabContainer"]'),
    ).filter(
      (w) =>
        !w.hasAttribute("data-film-seen") &&
        w.getBoundingClientRect().width > 0,
    );
    if (fresh.length !== 1)
      throw new Error(
        `promo-film desktop: ${fresh.length} new windows, expected exactly one`,
      );
    fresh[0]!.setAttribute("data-film", t);
  }, tag);
  return page.locator(`[data-film="${tag}"]`);
}

/** The shelf's app launcher → `name` → Enter: a window of that app (or the one already open, focused). */
async function launchWindow(page: Page, name: string): Promise<void> {
  await page.locator('button[aria-label="Apps"]').first().click();
  await page.waitForTimeout(800);
  await page.keyboard.type(name);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
}

/**
 * Lay window `win` out at `to` (CSS px, its outer box) the way a person
 * does: its size by its bottom-right corner, then its place by the bare
 * titlebar right of its tab (the tab is a chip with a drag of its own).
 * Real pointer input, outside any recorded frame (the film keeps only the
 * window settled in its place).
 */
async function placeWindow(
  page: Page,
  win: Locator,
  to: { x: number; y: number; width: number; height: number },
  /** Lets the page run a frame (a drag applies on its animation frames): real time before a recording, one recorded frame inside it. */
  tick: () => Promise<void>,
): Promise<void> {
  const drag = async (
    from: { x: number; y: number },
    by: { x: number; y: number },
  ): Promise<void> => {
    await page.mouse.move(from.x, from.y);
    await tick();
    await page.mouse.down();
    await tick();
    for (let k = 1; k <= 8; k++) {
      await page.mouse.move(from.x + (by.x * k) / 8, from.y + (by.y * k) / 8);
      await tick();
    }
    await page.mouse.up();
    for (let k = 0; k < 12; k++) await tick();
  };
  const box = await win.boundingBox();
  if (!box) throw new Error("promo-film desktop: the window has no box");
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
    throw new Error(
      "promo-film desktop: no resize handle at the window's corner",
    );
  await drag(corner, { x: to.width - box.width, y: to.height - box.height });
  const sized = await win.boundingBox();
  const tb = await win.locator('[role="tab"]').first().boundingBox();
  if (!sized || !tb)
    throw new Error("promo-film desktop: the window lost its box");
  const grab = { x: tb.x + tb.width + 40, y: tb.y + tb.height / 2 };
  await drag(grab, { x: to.x - sized.x, y: to.y - sized.y });
  const placed = await win.boundingBox();
  if (
    !placed ||
    Math.abs(placed.x - to.x) > 3 ||
    Math.abs(placed.y - to.y) > 3 ||
    Math.abs(placed.width - to.width) > 3 ||
    Math.abs(placed.height - to.height) > 3
  )
    throw new Error(
      `promo-film desktop: the window is at ${placed ? `${Math.round(placed.x)},${Math.round(placed.y)} ${Math.round(placed.width)}×${Math.round(placed.height)}` : "nowhere"}, not ${to.x},${to.y} ${to.width}×${to.height}`,
    );
}

/**
 * The desktop as the montage starts from, in real time (unrecorded): the
 * user's Places state, Circle installed, Home's one window laid where the
 * pull-back lands — and the work area every montage window must stay in.
 */
async function deskSetup(h: Harness) {
  const page = await session(h, DESK);
  await open(page, "/home");
  // Written before any app below loads, so each reads it from its start.
  // By now Circle is installed (the prototype segment showed it arrive): so
  // it is here too when this segment is re-recorded on its own after a seed.
  await showCircle(page);
  // Likewise the two Wishes' changes (`pages`: the cards' opening times;
  // `sonata`: the Current key section shown). They must be here even when
  // this segment records in a run of its own: the e2e harness reverts a
  // run's config writes when the run ends (its agent-write revert ledger), so
  // a `--only` run after the one that made them starts from the seed's state.
  await post(page, setConfigField, PLACES_HOURS_CONFIG);
  await post(page, resetConfigField, {
    storePath: SONATA_SECTION_LAYOUT,
    key: "items",
  });
  // The user's map, left over Paris (browser-local state): Places' window in
  // the montage shows their places, not an empty view.
  await rememberMapView(page, "places.map", {
    center: { lat: 48.862, lng: 2.345 },
    zoom: 12,
  });
  // Its side panel listing every place of the preset ("All"), so a small
  // window — its map mostly under the panel — still shows them.
  await open(page, "/places", { settleMs: 4000 });
  // The panel's scope switch (In view | All), a radio group; remembered in
  // browser storage, so the desktop's Places window opens on it.
  await page.getByRole("radio", { name: /^All\b/ }).click();
  // And in Gallery view, as the user left it (`placesAsLeft`): the cards
  // with their photos and the opening times the Wish added — the list view
  // shows neither. Browser storage too, so a run of this segment alone
  // (a fresh profile) sets it again.
  await page.locator('button[data-tooltip="Gallery"]').first().click();
  await page.waitForTimeout(800);
  const ids: MontageIds = { deploySite: await seededDeploySite(page) };
  await open(page, "/desktop", { settleMs: 3000, untitled: true });
  const pause = (ms = 2500) => page.waitForTimeout(ms);
  // The work area: the screen above the shelf.
  const shelf = await page
    .locator('button[aria-label="Apps"]')
    .first()
    .boundingBox();
  if (!shelf) throw new Error("promo-film desktop: no shelf");
  const work = { width: DESK.width, height: shelf.y - 16 };
  // One window: Home, the gallery the film pulls back from.
  await markWindows(page);
  await launchWindow(page, "Home");
  await pause(4000);
  const win = await tagNewWindow(page, "home-window");
  /** The window's titlebar height: the row holding its tab, as wide as the window. */
  const titlebarHeight = (): Promise<number> =>
    win.evaluate((w) => {
      const tab = w.querySelector('[role="tab"]');
      if (!tab) throw new Error("promo-film desktop: Home's window has no tab");
      const wr = w.getBoundingClientRect();
      let el: Element | null = tab;
      while (el && el.getBoundingClientRect().width < wr.width - 4)
        el = el.parentElement;
      if (!el) throw new Error("promo-film desktop: no titlebar row");
      return el.getBoundingClientRect().bottom - wr.top;
    });
  const bar = await titlebarHeight();
  // A window a person would leave, composed like a photograph: about half
  // the screen's width, near 16:10, up and left of centre (its centre near the left
  // third), the wallpaper's light open on its right. Its content shows the
  // full-screen gallery's very layout (centred and top-anchored, so the
  // same gallery cropped to the window), so the pull-back from the
  // full-screen gallery lands on it.
  const home = {
    x: 176,
    y: 124,
    width: HOME_CONTENT.width,
    height: HOME_CONTENT.height + bar,
  };
  await placeWindow(page, win, home, () => page.waitForTimeout(30));
  const homeBar = await titlebarHeight();
  /** A window's box, refused if it leaves the work area (it would be clamped, or cut by the shelf). */
  const rectOf = (a: (typeof MONTAGE)[number]["at"]) => {
    if (a.x + a.width > work.width || a.y + a.height > work.height)
      throw new Error(
        `promo-film desktop: a montage window (${a.x},${a.y} ${a.width}×${a.height}) leaves the ${work.width}×${Math.round(work.height)} work area`,
      );
    return a;
  };
  return { page, ids, win, home, homeBar, rectOf };
}

/** One montage window, opened from the shelf's launcher and laid at its place. */
async function openMontageWindow(
  page: Page,
  i: number,
  entry: (typeof MONTAGE)[number],
  ids: MontageIds,
  rectOf: (a: (typeof MONTAGE)[number]["at"]) => (typeof MONTAGE)[number]["at"],
  input: {
    click: (loc: Locator) => Promise<void>;
    type: (text: string) => Promise<void>;
    press: (key: string) => Promise<void>;
    hold: (s: number) => Promise<void>;
    mark: (name: string) => Promise<void>;
    tick: () => Promise<void>;
  },
): Promise<void> {
  const { app, route, keys, at } = entry;
  await markWindows(page);
  await input.click(page.locator('button[aria-label="Apps"]').first());
  await input.hold(0.4);
  await input.type(app);
  await input.press(route ? "Shift+Enter" : "Enter");
  await input.mark(`opening-${i}`);
  if (route) {
    await input.hold(0.6);
    await routeFocusedWindow(page, route(ids));
    await input.hold(1.6);
  } else await input.hold(1.0);
  await placeWindow(
    page,
    await tagNewWindow(page, `app-${i}`),
    rectOf(at),
    input.tick,
  );
  for (const key of keys ?? "") await input.press(key);
  await input.hold(0.8);
  await input.mark(`opened-${i}`);
}

/**
 * The montage laid out in real time, unrecorded — a still of the desktop
 * after each window lands (`<out>/opened-<i>.png`), to judge a layout before
 * a take. Writes nothing the film's story depends on but Circle's
 * place in the app layout (the desktop take un-hides it too).
 */
export async function previewMontage(h: Harness, out: string): Promise<void> {
  const { page, ids, rectOf } = await deskSetup(h);
  for (const [i, entry] of MONTAGE.entries()) {
    await openMontageWindow(page, i, entry, ids, rectOf, {
      click: (loc) => loc.click(),
      type: (text) => page.keyboard.type(text),
      press: (key) => page.keyboard.press(key),
      hold: (sec) => page.waitForTimeout(sec * 1000),
      mark: async (name) => {
        if (name.startsWith("opened-"))
          await page.screenshot({ path: join(out, `${name}.png`) });
      },
      tick: () => page.waitForTimeout(30),
    });
    console.log(`opened ${i}: ${entry.app}`);
  }
}

const desktop: SegmentFn = async ({ h }) => {
  const { page, ids, win, home, homeBar, rectOf } = await deskSetup(h);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(DESK.width / 2, 30);
  await page.waitForTimeout(1500);
  return rec(page, "desktop", { x: DESK.width / 2, y: 30 }, async (r) => {
    await r.mark("home-window", win);
    // Where the full-screen gallery (W × H) lies on the desktop: centred on
    // the window's content, from its top — the window's own gallery is that
    // one, cropped to the window.
    await r.mark("home-frame", {
      x: home.x + (home.width - W) / 2,
      y: home.y + homeBar,
      width: W,
      height: H,
    });
    // The film draws no pointer here (the camera pulls back over it).
    await r.hold(3.0);
    await r.mark("montage");
    // The montage: every app, a window each, laid where this user keeps it
    // (the film keeps one beat of each, settled).
    for (const [i, entry] of MONTAGE.entries())
      await openMontageWindow(page, i, entry, ids, rectOf, {
        // Travel by distance (the recorder's default): the first click comes
        // from the top of the screen down to the shelf (a fixed 0.2 s was a
        // flick); the later ones start on the button already.
        click: (loc) => r.click(loc),
        type: (text) => r.type(text, { cps: 40 }),
        press: (key) => r.press(key),
        hold: (sec) => r.hold(sec),
        mark: (name) => r.mark(name),
        tick: () => r.hold(1 / 60),
      });
    // Back to the gallery the film started on: Home's window, raised over
    // the mosaic — the montage's last cut lands on it (film: the hand is
    // drawn from here on).
    await r.click(page.locator('button[aria-label="Apps"]').first(), {
      duration: 0.2,
    });
    await r.hold(0.4);
    await r.type("Home", { cps: 40 });
    await r.press("Enter");
    await r.hold(1.0);
    await r.mark("home-focused");
    // Then the hand goes straight for its window's Full screen control, and
    // the app grows into the whole screen with the window's own motion (the
    // gallery full screen, as the film began) — the hand drifting on, in
    // the same movement, below the gallery, over nothing it would light.
    const full = await homeFullscreenControl(page, home, homeBar);
    await r.click(full, { dwell: 0.12 });
    await r.mark("fullscreen");
    await r.move(GALLERY_REST);
    // The window's growth (desktop/windows' FULLSCREEN_MS, 220 ms), then
    // the switch to the solo surface, settled.
    await r.hold(0.5);
    // Where the film's own screen lies in the full-screen gallery: its
    // layout is centred and top-anchored, so the opening's W × H is its
    // middle, from the top — the film lands its camera on it.
    await r.mark("gallery-frame", {
      x: (DESK.width - W) / 2,
      y: 0,
      width: W,
      height: H,
    });
    await r.mark("fullscreen-settled");
    // The gallery held (the film fades to the end card in it).
    await r.hold(3.0);
  });
};

/**
 * Where the hand rests on the full-screen gallery: where it rested as the
 * film opened ({@link OPENING_HAND}), in the part of the screen the film
 * lands on (`gallery-frame`) — below the tiles, lighting none, clear of both
 * top corners' hover zones.
 */
const GALLERY_REST = {
  x: (DESK.width - W) / 2 + OPENING_HAND.x,
  y: OPENING_HAND.y,
} as const;

/** Home's window's own Full screen control: the one in its titlebar (every window draws one). */
async function homeFullscreenControl(
  page: Page,
  home: { x: number; y: number; width: number; height: number },
  bar: number,
): Promise<Locator> {
  const found = await page.evaluate(
    ({ home, bar }) => {
      const hits = Array.from(
        document.querySelectorAll('button[aria-label="Full screen"]'),
      ).filter((b) => {
        const r = b.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        return (
          cx > home.x &&
          cx < home.x + home.width &&
          cy > home.y &&
          cy < home.y + bar
        );
      });
      if (hits.length !== 1) return hits.length;
      hits[0]!.setAttribute("data-film", "home-fullscreen");
      return 1;
    },
    { home, bar },
  );
  if (found !== 1)
    throw new Error(
      `promo-film desktop: ${found} Full screen controls in Home's titlebar, expected one`,
    );
  return page.locator('[data-film="home-fullscreen"]');
}

/** The film's segments, in film order: `film.ts` places them in this order. */
export const SEGMENTS: Record<string, SegmentFn> = {
  pages,
  sonata,
  prototype,
  desktop,
};
