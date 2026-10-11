// Drives the Chord trainer's Chords section end to end against this
// checkout's deploy (`research/2026-10-06-apps-chord-trainer-free-selection.md`,
// verification).
//
// What it checks, in the order it does it:
//
//   1. the Chords section is open and holds the Blanks pills;
//   2. Blanks → All: the next round asks every practised box and gives only
//      chords that are not practised;
//   3. Blanks → Random half: the next round asks half its practised boxes,
//      rounded up;
//   4. Blanks → Last half: the next round asks only boxes in the loop's second
//      half (or its last practised box), and the round played saves `half`;
//   5. a chip cycles Off → Hear → Practise → Off, its answer button coming
//      with Practise and going with Off — and the round on screen keeps its
//      boxes through every edit, with no flash: no loading state appears in
//      the progress panel or where the round goes, and the round's strip stays
//      the same DOM node (nothing remounts);
//   6. a section's rare group cycles to Practise: the Rare button appears;
//      the section set control (None / Hear) sets the whole section, and the
//      Rare button goes again;
//   7. Other chords per loop → 1: a later round holds a chord that is off;
//   8. Clear turns every chord off, and Undo clear puts them back.
//
// Usage:
//   ./singularity run plugins/apps/plugins/chord/plugins/curriculum/e2e/curriculum-verify.ts
//   … [--timeout-min 15] [--headed]
//
// Mutates server state. The selection it finds is put back before the verdict
// prints (including after a crash). The rounds it plays CANNOT be undone: the
// run prints how many rows it left.

import type { Locator, Page } from "playwright";
import { z } from "zod";
import {
  agentFetch,
  boot,
  onBeforeFinish,
  numArg,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ensureReady } from "@plugins/apps/plugins/chord/plugins/song-index/e2e";
import {
  ChordProgressSchema,
  encodeProgressParams,
  RecordRoundBodySchema,
  type ChordProgress,
} from "@plugins/apps/plugins/chord/plugins/progress/core";
import {
  CatalogStateSchema,
  SelectionSchema,
  chordState,
  groupState,
  listedTokens,
  playableChords,
  practisedChords,
  sameSelection,
  sectionTokens,
  type Blanks,
  type Catalog,
  type ChordChange,
  type ChordState,
  type Selection,
} from "@plugins/apps/plugins/chord/plugins/curriculum/core";
import {
  chordDigit,
  chordKeyPlan,
  chordLabel,
} from "@plugins/apps/plugins/chord/plugins/vocabulary/core";
import {
  chordTokenFromParts,
  type ChordToken,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";

const r = report("chord curriculum");
const timeoutMs = numArg("timeout-min", 15) * 60_000;

/** An answer box: "Chord 2, 4 beats" (plus ": IV", ", given", ", right"…). */
const BOX = 'button[aria-label^="Chord "][aria-label*=" beat"]';
/** The box strip, whose width turns a box's left edge into a place in the loop. */
const STRIP = ".chord-strip-boxes";
/** One answer button (a chord's, or Rare). */
const PAD = '[aria-label="Chords to choose from"] button[aria-keyshortcuts]';
/** The Rare joker's button. */
const RARE_PAD = `${PAD}[aria-label^="Rare,"]`;
/** The side panel ("Today", "Your chords", the Chords section). */
const PANEL = '[aria-label="Your progress"]';

// ── Watching for a flash ─────────────────────────────────────────────────────
//
// A chip click must not send anything back to loading: the progress read is
// keyed on the catalog, not the selection. `armFlashWatch` remembers the
// round's strip node and watches the trainer for a loading state (`Loading`
// renders `role="status"`), in the panel or in the main column;
// `readFlashWatch` says what it saw.

type FlashSeen = {
  loadingIn: string[];
  stripReplaced: boolean;
};

async function armFlashWatch(page: Page): Promise<void> {
  await page.evaluate(
    ({ strip, panel }) => {
      const w = window as unknown as {
        __chordFlash?: {
          seen: Set<string>;
          strip: Element | null;
          stop: () => void;
        };
      };
      w.__chordFlash?.stop();
      const seen = new Set<string>();
      const look = () => {
        for (const el of document.querySelectorAll(
          '.chord-trainer [role="status"]',
        )) {
          seen.add(
            el.closest(panel) === null
              ? "the round's column"
              : "the progress panel",
          );
        }
      };
      const observer = new MutationObserver(look);
      observer.observe(document.body, { childList: true, subtree: true });
      w.__chordFlash = {
        seen,
        strip: document.querySelector(strip),
        stop: () => observer.disconnect(),
      };
    },
    { strip: STRIP, panel: PANEL },
  );
}

async function readFlashWatch(page: Page): Promise<FlashSeen> {
  return page.evaluate((strip) => {
    const w = window as unknown as {
      __chordFlash?: {
        seen: Set<string>;
        strip: Element | null;
        stop: () => void;
      };
    };
    const watch = w.__chordFlash;
    if (watch === undefined) throw new Error("the flash watch was not armed");
    watch.stop();
    return {
      loadingIn: [...watch.seen],
      stripReplaced:
        watch.strip === null || document.querySelector(strip) !== watch.strip,
    };
  }, STRIP);
}

const vi = chordTokenFromParts({ root: 9, intervals: [3, 4], inversion: 0 });

// ── Reading the app from outside ─────────────────────────────────────────────

async function readResource(name: string, query = ""): Promise<unknown> {
  const res = await agentFetch(`/api/resources/${name}${query}`);
  if (!res.ok) {
    throw new Error(`GET /api/resources/${name} → HTTP ${res.status}`);
  }
  const { value } = z.object({ value: z.unknown() }).parse(await res.json());
  return value;
}

async function readSelection(): Promise<Selection> {
  return SelectionSchema.parse(await readResource("chord.curriculum"));
}

async function readCatalog(): Promise<Catalog> {
  const settled = await waitFor(
    async () => CatalogStateSchema.parse(await readResource("chord.catalog")),
    (state) => state.kind === "ready",
    { timeoutMs: 120_000, intervalMs: 1000 },
  );
  const state = settled.value;
  if (state.kind !== "ready") {
    throw new Error("chord.catalog stayed not-ready for 2 minutes");
  }
  return state.catalog;
}

async function readProgress(
  tokens: readonly ChordToken[],
): Promise<ChordProgress> {
  const params = encodeProgressParams({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tokens: [...tokens],
  });
  const query = `?${new URLSearchParams(params).toString()}`;
  return ChordProgressSchema.parse(await readResource("chord.progress", query));
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await agentFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
}

const setChords = (changes: readonly ChordChange[]) =>
  post("/api/chord/curriculum/chords", { changes });

/** One selection in a few words, for the transcript. */
function selectionText(s: Selection): string {
  const shown = s.chords
    .slice(0, 12)
    .map(
      (c) =>
        `${chordLabel(c.token).text}${c.state === "hear" ? " (hear)" : ""}`,
    );
  const more = s.chords.length > 12 ? ` +${s.chords.length - 12} more` : "";
  return `${shown.join(" ")}${more} · blanks ${s.blanks} · extras ${String(s.extras)}`;
}

/** The changes that turn `now` into `want`, chord by chord. */
function changesTo(now: Selection, want: Selection): ChordChange[] {
  const tokens = new Set([
    ...now.chords.map((c) => c.token),
    ...want.chords.map((c) => c.token),
  ]);
  return [...tokens]
    .filter((token) => chordState(now, token) !== chordState(want, token))
    .map((token) => ({ token, state: chordState(want, token) }));
}

// ── Reading the answer strip ─────────────────────────────────────────────────

type BoxRead = {
  position: number;
  beats: number;
  /** The chord it shows: its own once given or checked, else the answer given. */
  chord: string | null;
  given: boolean;
  mark: "right" | "wrong" | null;
  /** Where the box starts in the loop, 0…1 (its left edge over the strip's width). */
  fraction: number;
};

type StripRead = { heading: string; song: string; boxes: BoxRead[] };

/**
 * How many passes the strip could be, judged by its rhythm alone (an unfilled
 * box shows no chord): 1, and every k whose passes put their boxes at the same
 * places. The trainer's rule (`askedPositions`) also compares the chords, so
 * the real count is one of these.
 */
function passCounts(strip: StripRead): number[] {
  const n = strip.boxes.length;
  const counts = [1];
  for (let k = 2; k <= n; k += 1) {
    if (n % k !== 0) continue;
    const perPass = n / k;
    const same = strip.boxes.every((box, i) => {
      const echo = strip.boxes[i + perPass];
      return (
        echo === undefined ||
        (echo.beats === box.beats &&
          Math.abs(echo.fraction - box.fraction - 1 / k) < 0.01)
      );
    });
    if (same) counts.push(k);
  }
  return counts;
}

const BOX_LABEL =
  /^Chord (?<position>\d+), (?<beats>[\d.]+) beats?(?:: (?<chord>[^,]+)(?:, (?!given$|given,|right$|wrong$)(?<name>[^,]+))?)?(?<given>, given)?(?:, (?<mark>right|wrong))?$/;

function boxMark(label: string, text: string | undefined): BoxRead["mark"] {
  if (text === undefined) return null;
  if (text === "right" || text === "wrong") return text;
  throw new Error(
    `An answer box reads "${label}": "${text}" is not a mark this script knows (right, wrong)`,
  );
}

async function readStrip(page: Page): Promise<StripRead | null> {
  const raw = await page.evaluate(
    ({ strip, box }) => {
      const host = document.querySelector(strip);
      if (host === null) return null;
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width === 0) return null;
      return {
        heading: document.querySelector("h2")?.textContent ?? "",
        song: document.querySelector("h1")?.textContent ?? "",
        boxes: [...host.querySelectorAll(box)].map((el) => ({
          label: el.getAttribute("aria-label") ?? "",
          fraction:
            (el.getBoundingClientRect().left - hostRect.left) / hostRect.width,
        })),
      };
    },
    { strip: STRIP, box: BOX },
  );
  if (raw === null) return null;
  const boxes = raw.boxes.map(({ label, fraction }) => {
    const parsed = BOX_LABEL.exec(label)?.groups;
    if (parsed === undefined) {
      throw new Error(
        `An answer box reads "${label}", which is not a box label`,
      );
    }
    return {
      position: Number(parsed.position) - 1,
      beats: Number(parsed.beats),
      chord: parsed.chord ?? null,
      given: parsed.given !== undefined,
      mark: boxMark(label, parsed.mark),
      fraction,
    };
  });
  return {
    heading: raw.heading.replace(/\s+/g, " ").trim(),
    song: raw.song.replace(/\s+/g, " ").trim(),
    boxes,
  };
}

function loopIdentity(strip: StripRead): string {
  const boxes = strip.boxes
    .map((box) => `${box.chord ?? "–"}@${box.fraction.toFixed(3)}/${box.beats}`)
    .join(",");
  return `${strip.song}|${boxes}`;
}

/** The loop AND which of its boxes are asked: what must not move on an edit. */
const roundShape = (strip: StripRead): string =>
  `${loopIdentity(strip)}|asked ${asked(strip)
    .map((b) => b.position)
    .join(",")}`;

const isUnanswered = (strip: StripRead): boolean =>
  /^Chord \d+ of \d+$/.test(strip.heading);
const asked = (strip: StripRead): BoxRead[] =>
  strip.boxes.filter((box) => !box.given);
const given = (strip: StripRead): BoxRead[] =>
  strip.boxes.filter((box) => box.given);

function stripText(strip: StripRead): string {
  const boxes = strip.boxes
    .map(
      (box) =>
        `${box.given ? "given" : "ask"} ${box.chord ?? "–"}@${box.fraction.toFixed(2)}`,
    )
    .join(", ");
  return `"${strip.heading}" — ${boxes}`;
}

async function shows(locator: Locator, timeoutMs = 30_000): Promise<boolean> {
  return locator.waitFor({ state: "visible", timeout: timeoutMs }).then(
    () => true,
    (err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") return false;
      throw err;
    },
  );
}

async function whyNoRound(page: Page): Promise<string> {
  const text = await page.locator("body").first().innerText();
  return text.replace(/\s+/g, " ").slice(0, 400);
}

async function requireRound(
  page: Page,
  what: string,
  notThis: string | null = null,
): Promise<StripRead> {
  const settled = await waitFor(
    () => readStrip(page),
    (strip) =>
      strip !== null &&
      isUnanswered(strip) &&
      (notThis === null || loopIdentity(strip) !== notThis),
    { timeoutMs: 90_000, intervalMs: 250 },
  );
  const strip = settled.value;
  if (settled.ok && strip !== null) return strip;
  r.fail(
    `a round to play (${what})`,
    `waited ${Math.round(settled.waitedMs / 1000)} s; ` +
      (strip === null
        ? `the screen reads: ${await whyNoRound(page)}`
        : notThis !== null && loopIdentity(strip) === notThis
          ? `the trainer stayed on the same loop: ${stripText(strip)}`
          : `the round on screen reads ${stripText(strip)}`),
  );
  return r.finish();
}

/** Hand focus back to the page, so the trainer's keys reach it. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

/** Drop the loop on screen and wait for the NEXT one — a different loop. */
async function nextSong(page: Page, what: string): Promise<StripRead> {
  const leaving = await readStrip(page);
  await blur(page);
  await page.keyboard.press("Enter");
  return requireRound(
    page,
    what,
    leaving === null ? null : loopIdentity(leaving),
  );
}

// ── Playing a round ──────────────────────────────────────────────────────────

/** Fill every asked box with one digit that answers on its own; returns the saved body. */
async function playRound(
  page: Page,
  strip: StripRead,
  selection: Selection,
  listed: ReadonlySet<ChordToken>,
): Promise<z.infer<typeof RecordRoundBodySchema>> {
  const practised = practisedChords(selection).filter((t) => listed.has(t));
  const solo = chordKeyPlan(practised).find((g) => g.tokens.length === 1);
  if (solo === undefined) {
    throw new Error(
      `every practised chord shares its digit with another (${practised.map((token) => `${chordLabel(token).text} on ${chordDigit(token)}`).join(", ")}), so one keystroke answers nothing`,
    );
  }
  const saved = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/chord/rounds" &&
      res.request().method() === "POST",
    { timeout: 60_000 },
  );
  await blur(page);
  for (let i = 0; i < asked(strip).length; i += 1) {
    await page.keyboard.press(solo.digit);
  }
  const res = await saved.catch(async (err: unknown) => {
    if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
    const now = await readStrip(page);
    r.fail(
      "the round is saved",
      `pressed ${solo.digit} ${String(asked(strip).length)}× and no POST /api/chord/rounds came — the strip reads ${now === null ? "nothing" : stripText(now)}`,
    );
    return r.finish();
  });
  if (!res.ok()) {
    r.fail("the round is saved", `POST /api/chord/rounds → ${res.status()}`);
    return r.finish();
  }
  return RecordRoundBodySchema.parse(res.request().postDataJSON());
}

// ── Where the learner is, and putting it back ────────────────────────────────

const start = await readSelection();
r.note(`the learner starts at ${selectionText(start)}`);

/** Put the selection back: every chord's state, the blanks, the extras. */
onBeforeFinish(async () => {
  const now = await readSelection();
  const changes = changesTo(now, start);
  if (changes.length > 0) await setChords(changes);
  await post("/api/chord/curriculum/blanks", { blanks: start.blanks });
  await post("/api/chord/curriculum/extras", { extras: start.extras });
  const back = await waitFor(readSelection, (s) => sameSelection(s, start), {
    timeoutMs: 20_000,
    intervalMs: 250,
  });
  r.ok(
    "the selection is back where it was found",
    back.ok,
    `${selectionText(back.value)} — started at ${selectionText(start)}`,
  );
});

await ensureReady(r, timeoutMs);
const catalog = await readCatalog();
const listed = listedTokens(catalog);
const major = catalog.tracks.find((t) => t.id === "major");
if (major === undefined) throw new Error("the catalog has no Major track");

// The run needs I, IV and V practised (one keystroke each) and vi off: start
// from there, whatever the learner had.
const home = [0, 5, 7].map((root) =>
  chordTokenFromParts({ root, intervals: [4, 3], inversion: 0 }),
);
const baseline: Selection = {
  chords: home.map((token) => ({ token, state: "practice" as const })),
  blanks: "half",
  extras: 0,
};
{
  const now = await readSelection();
  const changes = changesTo(now, baseline);
  if (changes.length > 0) await setChords(changes);
  await post("/api/chord/curriculum/extras", { extras: 0 });
}

const progressTokens = [...new Set([...home, vi])];
const before = await readProgress(progressTokens);
let roundsPlayed = 0;
let answersGiven = 0;

async function selectionWhere(
  what: string,
  check: (s: Selection) => boolean,
): Promise<Selection> {
  const settled = await waitFor(readSelection, check, {
    timeoutMs: 20_000,
    intervalMs: 250,
  });
  r.ok(what, settled.ok, selectionText(settled.value));
  return settled.value;
}

// A throw inside the browser run must still reach `r.finish()`, which is what
// runs the restore above: a top-level await that rejects ends the script
// before any `onBeforeFinish` hook.
await withBrowser(async ({ session }) => {
  const { page, captured } = await session({
    viewport: { width: 1320, height: 1000 },
  });
  await boot(page, pathUrl("/chord"), { marker: BOX, timeoutMs });
  await requireRound(page, "the first round");

  // ── 1. the Chords section is open ──────────────────────────────────────────

  const pill = (group: string, label: string) =>
    page
      .getByRole("radiogroup", { name: group })
      .getByRole("radio", { name: label, exact: true });
  if (!(await pill("Blanks", "All").isVisible())) {
    await page.getByRole("button", { name: "Chords", exact: true }).click();
  }
  r.ok(
    "the Chords section shows the Blanks pills",
    await shows(pill("Blanks", "All"), 10_000),
    "no All pill",
  );

  const choose = async (
    group: string,
    label: string,
    check: (s: Selection) => boolean,
  ) => {
    await pill(group, label).click();
    const saved = await selectionWhere(`${group} → ${label} is saved`, check);
    const shown = await waitFor(
      () => pill(group, label).getAttribute("aria-checked"),
      (checked) => checked === "true",
      { timeoutMs: 15_000, intervalMs: 200 },
    );
    r.ok(
      `the page shows ${group} → ${label}`,
      shown.ok,
      `aria-checked=${String(shown.value)}`,
    );
    return saved;
  };
  const setBlanks = (label: string, blanks: Blanks) =>
    choose("Blanks", label, (s) => s.blanks === blanks);
  const isPractised = (s: Selection, label: string | null) =>
    label !== null &&
    practisedChords(s).some((t) => chordLabel(t).text === label);

  // ── 2. All ─────────────────────────────────────────────────────────────────

  let selection = await setBlanks("All", "all");
  let strip = await nextSong(page, "a whole-loop round");
  r.note(`whole-loop round: ${stripText(strip)}`);
  r.ok(
    "at All the round gives only chords that are not practised",
    given(strip).every((box) => !isPractised(selection, box.chord)),
    stripText(strip),
  );
  r.eq(
    "the heading counts the asked boxes",
    strip.heading,
    `Chord 1 of ${String(asked(strip).length)}`,
  );

  // ── 3. Random half ─────────────────────────────────────────────────────────

  selection = await setBlanks("Random half", "random");
  strip = await nextSong(page, "a random-half round");
  r.note(`random-half round: ${stripText(strip)}`);
  {
    // A practised box is asked, or given under its own practised name.
    const practisedBoxes =
      asked(strip).length +
      given(strip).filter((b) => isPractised(selection, b.chord)).length;
    // A loop that replays itself draws within one pass (`askedPositions`).
    r.ok(
      "at Random half the round asks half its practised boxes, rounded up — per pass when the loop replays itself",
      passCounts(strip).some(
        (passes) =>
          asked(strip).length ===
          passes * Math.ceil(practisedBoxes / passes / 2),
      ),
      `${String(asked(strip).length)} asked of ${String(practisedBoxes)}`,
    );
  }

  // ── 4. Last half ───────────────────────────────────────────────────────────

  selection = await setBlanks("Last half", "half");
  strip = await nextSong(page, "a last-half round");
  for (let tries = 0; tries < 6 && strip.boxes.length < 2; tries += 1) {
    strip = await nextSong(page, "a last-half round with more than one box");
  }
  r.note(`last-half round: ${stripText(strip)}`);
  // The second half of the loop — or of each pass, when it replays itself.
  const secondHalf = passCounts(strip).some((passes) =>
    asked(strip).every((box) => (box.fraction * passes) % 1 >= 0.49),
  );
  const fallback =
    asked(strip).length === 1 &&
    strip.boxes.filter((b) => b.fraction >= 0.49).every((b) => b.given);
  r.ok(
    "at Last half the round asks only the second half (or its last practised box)",
    asked(strip).length > 0 && (secondHalf || fallback),
    stripText(strip),
  );
  const body = await playRound(page, strip, selection, listed);
  roundsPlayed += 1;
  answersGiven += body.answers.length;
  r.eq("the saved round says it was asked at Last half", body.blanks, "half");

  // ── 5. a chip cycles; the round on screen never changes ────────────────────

  strip = await nextSong(page, "a round to edit under");
  const frozen = roundShape(strip);
  const keepsItsBoxes = async (after: string) => {
    const now = await readStrip(page);
    r.ok(
      `the round on screen keeps its boxes after ${after}`,
      now !== null && roundShape(now) === frozen,
      now === null ? "no round" : `${stripText(now)} — was ${frozen}`,
    );
  };
  const majorBody = page.locator(`[aria-label="${major.name}"]`);
  const viLabel = chordLabel(vi).text;
  const chip = (state: ChordState) =>
    majorBody.getByRole("button", {
      name: `${viLabel}, ${state === "off" ? "Off" : state === "hear" ? "Hear" : "Practise"}`,
      exact: true,
    });
  const pads = () => page.locator(PAD).count();
  const padsOff = await pads();
  const cycle = async (from: ChordState, to: ChordState, padsWant: number) => {
    await armFlashWatch(page);
    await chip(from).click();
    await selectionWhere(
      `the ${viLabel} chip goes ${from} → ${to}`,
      (s) => chordState(s, vi) === to,
    );
    // Give a re-keyed read time to show itself (it would go pending at once).
    await page.waitForTimeout(1000);
    const flash = await readFlashWatch(page);
    r.ok(
      `no loading state flashes after ${viLabel} → ${to}`,
      flash.loadingIn.length === 0,
      `a loading state appeared in ${flash.loadingIn.join(" and ")}`,
    );
    r.ok(
      `the round's strip stays the same node after ${viLabel} → ${to}`,
      !flash.stripReplaced,
      "the strip was unmounted and mounted again",
    );
    const n = await waitFor(pads, (count) => count === padsWant, {
      timeoutMs: 20_000,
      intervalMs: 250,
    });
    r.eq(`answer buttons with ${viLabel} at ${to}`, n.value, padsWant);
    await keepsItsBoxes(`${viLabel} → ${to}`);
  };
  await cycle("off", "hear", padsOff);
  await cycle("hear", "practice", padsOff + 1);
  await cycle("practice", "off", padsOff);
  await pill("Blanks", "All").click();
  await selectionWhere("Blanks → All again", (s) => s.blanks === "all");
  await keepsItsBoxes("a Blanks change");

  // ── 6. a rare group, and a whole section ───────────────────────────────────

  const rareSection = major.sections.find(
    (s) => s.kind === "section" && s.rare !== null,
  );
  if (rareSection === undefined || rareSection.rare === null) {
    r.note("skipped the rare-group step: no Major section has a rare group");
  } else {
    const group = rareSection.rare.tokens;
    const tokens = sectionTokens(rareSection);
    const label = `+${String(group.length)} rare in ${rareSection.name}`;
    const rareChip = (state: string) =>
      majorBody.getByRole("button", {
        name: `${label}, ${state}`,
        exact: true,
      });
    await rareChip("Off").click();
    await selectionWhere(
      `${label} → Hear`,
      (s) => groupState(s, group) === "hear",
    );
    await rareChip("Hear").click();
    await selectionWhere(
      `${label} → Practise`,
      (s) => groupState(s, group) === "practice",
    );
    r.ok(
      "practising a rare group brings the Rare button",
      await shows(page.locator(RARE_PAD), 20_000),
      "no Rare button",
    );
    const set = async (word: "Hear" | "None", state: ChordState) => {
      const control = majorBody.getByRole("button", {
        name: `${rareSection.name}: ${word}`,
        exact: true,
      });
      // The section set control shows on hover: point at the section first.
      await majorBody
        .getByText(rareSection.name, { exact: true })
        .first()
        .hover();
      await control.click();
      await selectionWhere(
        `${rareSection.name}: ${word} sets all ${String(tokens.length)} of its chords`,
        (s) => groupState(s, tokens) === state,
      );
    };
    await set("Hear", "hear");
    await set("None", "off");
    const gone = await waitFor(
      () => page.locator(RARE_PAD).count(),
      (n) => n === 0,
      { timeoutMs: 20_000, intervalMs: 250 },
    );
    r.eq("no rare chord practised: no Rare button", gone.value, 0);
  }

  // ── 7. Other chords per loop → 1 ───────────────────────────────────────────

  selection = await choose("Other chords per loop", "1", (s) => s.extras === 1);
  const playable = new Set(
    playableChords(selection).map((t) => chordLabel(t).text),
  );
  let extra: StripRead | null = null;
  for (let tries = 0; tries < 12 && extra === null; tries += 1) {
    strip = await nextSong(page, "a round that may hold another chord");
    if (given(strip).some((b) => b.chord !== null && !playable.has(b.chord))) {
      extra = strip;
    }
  }
  r.ok(
    "with one other chord per loop, a round holds a chord that is off (given)",
    extra !== null,
    extra === null ? "12 rounds, all made of the chords on" : stripText(extra),
  );
  await choose("Other chords per loop", "None", (s) => s.extras === 0);

  // ── 8. Clear, then Undo clear ──────────────────────────────────────────────

  const beforeClear = await readSelection();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await selectionWhere(
    "Clear turns every chord off",
    (s) => s.chords.length === 0,
  );
  const undo = page.getByRole("button", { name: "Undo clear", exact: true });
  r.ok("Undo clear is offered", await shows(undo, 5_000), "no Undo clear");
  await undo.click();
  await selectionWhere("Undo clear puts every chord back", (s) =>
    sameSelection(s, beforeClear),
  );

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join("\n"),
  );
}).catch((err: unknown) => {
  r.fail(
    "the browser run finished",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
});

const end = await readProgress(progressTokens);
r.note(
  `left behind: ${roundsPlayed} rounds and ${answersGiven} answers, which nothing can undo ` +
    `(all time is now ${end.allTime.songs} songs, ${end.allTime.answers} answers; was ${before.allTime.songs}).`,
);

await r.finish();
