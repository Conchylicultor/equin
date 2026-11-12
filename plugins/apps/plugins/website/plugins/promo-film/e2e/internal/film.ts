// The whole film (Script v4), from the recordings (record.ts): one continuous
// session of the real app, ending on equin's desktop mode, then a direct fade
// to the end card. The timeline is derived from the recordings — each segment
// plays at its real speed except its time-lapses — so re-recording a segment
// re-times everything after it.
//
// What the film adds over the app's own pixels, and nothing else:
// - the camera: a push-in on the Pick UI element button and on each Wish
//   prompt while it is typed, and on what an agent changed — every move framed
//   so its target is never cropped, on every frame of the move too;
// - the time-lapse look (a VHS fast-forward: ▶▶, scanlines, a tracking band,
//   colour fringing and a running clock) over every stretch the film speeds up;
// - a glow around what an agent changed (the cards' opening times, the new
//   Sonata section, Circle's tile);
// - the desktop pull-back from the gallery, the closing montage (every app
//   opening in a window, a few readable beats then faster and faster, the
//   focal window and then Home's window raised on that same accelerating
//   cadence — the hand takes it full screen with the window's own motion,
//   landing on the very framing the film opened on) and the end card.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cameraMove,
  frameOn,
  html,
  ring,
  text,
  type AssetManifest,
  type CameraView,
  type Easing,
  type Composition,
  type Key,
  type Layer,
  type Rect,
  type SfxCue,
} from "@plugins/media/plugins/film/e2e";
import {
  CENTER,
  CLICK_GAIN,
  H,
  mergeCam,
  W,
  type CamKeys,
  type Scene,
} from "./kit";
import { filmMusicBeat, resolveFilmMusic, type FilmMusic } from "./music";
import { outro, titleCard } from "./outro";
import { place, recDuration, recMark, type Knot, type Placed } from "./place";
import { SEGMENTS } from "./segments";
import { REC_DIR } from "./session-kit";

/** The montage's readable beats, before it accelerates. */
const MONTAGE_READABLE = 3;
/** Each accelerating interval, as a fraction of the one before. */
const MONTAGE_EASE = 0.7;
/**
 * The montage's pace in seconds — what the eye reads, whatever the track's
 * tempo: each readable window ~0.7 s (v18's, cut on a 172 BPM grid;
 * counting them in sixteenths instead made them grow with a slower track —
 * v19's 130 BPM held each window 0.92 s).
 */
const MONTAGE_READ_S = 0.7;

/**
 * How long each montage window holds before the next cut, in steps of
 * `step` seconds (the music's sixteenth, so every cut lands on an onset):
 * {@link MONTAGE_READABLE} at {@link MONTAGE_READ_S}, then ×{@link
 * MONTAGE_EASE} each — every one rounded to the nearest step, strictly
 * shorter than the one before until it is a single step. The last window
 * (the focal one) is no exception: Home's window raised over the mosaic is
 * the next cut on the same accelerating cadence, so the accumulation runs
 * straight into the gallery — the gallery is the beat that lands (it holds
 * while the hand reaches its Full screen control). (v20 held the focal window
 * 1.4 s and v21 one readable beat, 0.7 s: both read as a stop before the
 * gallery.) 13 windows at 130 BPM (a 0.115 s sixteenth):
 * 6 6 6 4 3 2 1 1 1 1 1 1 1, then Home.
 */
export function montageIntervals(windows: number, step: number): number[] {
  const steps = (s: number): number => Math.max(1, Math.round(s / step));
  const out: number[] = [];
  let pace = MONTAGE_READ_S;
  for (let i = 0; i < windows; i++) {
    if (i < MONTAGE_READABLE) {
      out.push(steps(pace));
      continue;
    }
    pace *= MONTAGE_EASE;
    const before = out.at(-1) ?? Infinity;
    out.push(Math.max(1, Math.min(before - 1, steps(pace))));
  }
  return out;
}

/**
 * The opening title's length: the session starts under it as it fades
 * (titleCard), mirroring the end card.
 */
const INTRO = 2.3;
/** How much faster than real time the time-lapses run. */
const LAPSE_SPEED = 4;
const STAGE = { width: W, height: H };
const REST: CameraView = { focus: CENTER, zoom: 1 };
/** The glow around what an agent changed. */
const GLOW = "oklch(0.82 0.15 85)";

/** The recordings, as one manifest (each recording's last frame also a still). */
function loadAssets(): AssetManifest {
  const m: AssetManifest = {
    dpr: 2,
    width: W,
    height: H,
    stills: {},
    rects: {},
    sequences: {},
    strips: {},
    stripRects: {},
    audio: {},
  };
  for (const name of Object.keys(SEGMENTS)) {
    const file = join(REC_DIR, `${name}.json`);
    if (!existsSync(file))
      throw new Error(
        `promo-film: no recording "${name}" — run e2e/record.ts --only ${name}`,
      );
    const seq = JSON.parse(
      readFileSync(file, "utf8"),
    ) as AssetManifest["sequences"][string];
    // A screen larger than the film's in CSS px (the desktop's): drawn on
    // the film's stage, so everything it logged in its own CSS px (marks,
    // pointer, clicks) is scaled onto the stage too.
    const k = W / seq.clip.width;
    if (Math.abs(k - 1) > 1e-6 && seq.input) {
      for (const mk of Object.values(seq.input.marks))
        if (mk.rect)
          mk.rect = {
            x: mk.rect.x * k,
            y: mk.rect.y * k,
            width: mk.rect.width * k,
            height: mk.rect.height * k,
          };
      seq.input.cursor = seq.input.cursor.map(([t, x, y]) => [t, x * k, y * k]);
      seq.input.clicks = seq.input.clicks.map((c) => ({
        ...c,
        x: c.x * k,
        y: c.y * k,
      }));
    }
    seq.clip = { x: 0, y: 0, width: W, height: H };
    m.sequences[name] = seq;
    const last = seq.frames[seq.frames.length - 1];
    if (!last) throw new Error(`promo-film: "${name}" has no frame`);
    m.stills[`${name}-last`] = { file: last, x: 0, y: 0, width: W, height: H };
  }
  return m;
}

/**
 * The camera is calmer than the cursor: a push-in is slow and eased (it asks
 * the viewer to look closer — a long, soft start and a long settle), the
 * pull-back quicker.
 */
const PUSH_IN: { dur: number; easing: Easing } = {
  dur: 1.2,
  easing: { bezier: [0.42, 0, 0.18, 1] },
};
const PULL_OUT: { dur: number; easing: Easing } = {
  dur: 0.8,
  easing: { bezier: [0.4, 0, 0.25, 1] },
};

/**
 * A push-in on `r` (whole, plus a margin), arriving at `inAt` — so it starts
 * `PUSH_IN.dur` before, already on its way when the thing it frames happens —
 * and back out from `outAt`; never cutting it.
 */
function pushIn(
  r: Rect,
  inAt: number,
  outAt: number,
  maxZoom: number,
): CamKeys[] {
  const v = frameOn(r, { stage: STAGE, margin: 32, maxZoom });
  const start = inAt - PUSH_IN.dur;
  const out = Math.max(outAt, inAt + 0.2);
  return [
    cameraMove(start, inAt, REST, v, {
      stage: STAGE,
      keep: r,
      easing: PUSH_IN.easing,
    }),
    cameraMove(out, out + PULL_OUT.dur, v, REST, {
      stage: STAGE,
      keep: r,
      easing: PULL_OUT.easing,
    }),
  ];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The time-lapse look over film [a, b]: a VHS fast-forward. A dark wash and
 * scanlines, a tracking band rolling up the screen, "▶▶" and a clock running
 * through `clock` (minutes of the user's day, from → to) top left, and the
 * picture itself doubled, offset and tinted for the colour fringing (`seq` is
 * the segment's sequence layer, drawn again under the overlay).
 */
function vhs(
  a: number,
  b: number,
  seq: Layer,
  clock: { from: number; to: number },
): { layers: Layer[]; overlay: Layer[] } {
  const op: Key[] = [
    [a, 0],
    [a + 0.12, 1, "outSine"],
    [b - 0.12, 1],
    [b, 0, "inSine"],
  ];
  const fringe = (dx: number, hue: number): Layer => ({
    ...seq,
    id: `${seq.id ?? "seq"}-fringe-${a.toFixed(2)}-${dx}`,
    start: a,
    end: b,
    x: dx,
    blend: "screen",
    style: {
      filter: `sepia(1) saturate(8) hue-rotate(${hue}deg) brightness(0.6)`,
    },
    // A key without an easing stays without one: `[t, v, undefined]` reaches
    // the renderer page as `[t, v, null]`, which no easing names.
    opacity: op.map(([t, v, e]): Key => (e ? [t, v * 0.32, e] : [t, v * 0.32])),
  });
  const overlay: Layer[] = [
    html(
      `<div style="width:${W}px;height:${H}px;background:repeating-linear-gradient(to bottom, rgba(0,0,0,0.16) 0 1px, transparent 1px 3px), radial-gradient(ellipse 80% 75% at 50% 50%, transparent 55%, rgba(0,0,0,0.5) 100%);"></div>`,
      W,
      H,
      { start: a, end: b, opacity: op },
    ),
    // The tracking band: a soft bright smear rolling up the frame.
    html(
      `<div style="width:${W}px;height:46px;background:linear-gradient(to bottom, transparent, rgba(255,255,255,0.10) 45%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.10) 55%, transparent);filter:blur(1px)"></div>`,
      W,
      46,
      {
        start: a,
        end: b,
        x: 0,
        y: [
          [a, H - 10],
          [b, -60],
        ],
        opacity: op,
      },
    ),
    html(
      `<div style="font:700 30px/1 'JetBrains Mono','SF Mono',Menlo,monospace;color:#f4f4f5;letter-spacing:0.04em;text-shadow:2px 0 rgba(255,40,80,0.7),-2px 0 rgba(40,200,255,0.7)">▶▶</div>`,
      120,
      40,
      { start: a, end: b, x: 44, y: 36, opacity: op },
    ),
  ];
  // The clock: the user's afternoon running by, one tick per 0.1 s of film.
  const ticks = Math.max(1, Math.round((b - a) / 0.1));
  for (let i = 0; i < ticks; i++) {
    const t0 = a + ((b - a) * i) / ticks;
    const t1 = a + ((b - a) * (i + 1)) / ticks;
    const min = clock.from + ((clock.to - clock.from) * i) / ticks;
    const hh = Math.floor(min / 60);
    const mm = Math.floor(min % 60);
    const ss = Math.floor((min * 60) % 60);
    overlay.push(
      text(`${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`, {
        size: 24,
        weight: 600,
        color: "#f4f4f5",
        letterSpacing: "0.06em",
        x: 112,
        y: 40,
        start: t0,
        end: t1,
        style: {
          "font-family": "'JetBrains Mono','SF Mono',Menlo,monospace",
          "text-shadow":
            "2px 0 rgba(255,40,80,0.6),-2px 0 rgba(40,200,255,0.6)",
        },
        opacity: op,
      }),
    );
  }
  return { layers: [fringe(4, -40), fringe(-4, 160)], overlay };
}

/** `r` cut to the stage: the part of an element the viewer sees. */
function onScreen(r: Rect): Rect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const right = Math.min(W, r.x + r.width);
  const bottom = Math.min(H, r.y + r.height);
  if (right <= x || bottom <= y)
    throw new Error(
      `promo-film: [${r.x}, ${r.y}, ${r.width}, ${r.height}] is off screen`,
    );
  return { x, y, width: right - x, height: bottom - y };
}

/** A glow around `r` (an agent's change), fading in at `at`, held, out by `to`. */
function glow(r: Rect, at: number, to: number): Layer {
  return ring(r, {
    pad: 6,
    color: GLOW,
    radius: 10,
    thickness: 2.5,
    glow: 22,
    start: at,
    end: to,
    opacity: [
      [at, 0],
      [at + 0.35, 1, "outCubic"],
      [to - 0.5, 1],
      [to, 0, "inSine"],
    ],
  });
}

/**
 * Knots for a recording placed at film `t`: real speed, except each lapse
 * ([`from`, `to`], recording seconds, in order) played `speed`× faster.
 */
function withLapse(
  m: AssetManifest,
  name: string,
  t: number,
  ...lapses: Array<{ from: number; to: number; speed: number }>
): Knot[] {
  const D = recDuration(m, name);
  const knots: Knot[] = [[t, 0]];
  let film = t;
  let rec = 0;
  for (const l of lapses) {
    if (l.from > rec) {
      film += l.from - rec;
      knots.push([film, l.from]);
    }
    film += (l.to - l.from) / l.speed;
    knots.push([film, l.to]);
    rec = l.to;
  }
  if (D > rec) knots.push([film + (D - rec), D]);
  return knots;
}

function caption(str: string, from: number, to: number): Layer {
  const inAt = from + 0.35;
  return text(str, {
    size: 19,
    weight: 500,
    color: "rgba(255,255,255,0.92)",
    letterSpacing: "-0.005em",
    x: 40,
    y: 650,
    start: inAt,
    end: to,
    style: {
      "text-shadow": "0 1px 2px rgba(0,0,0,0.35)",
      background: "rgba(12,14,20,0.62)",
      "backdrop-filter": "blur(14px)",
      "-webkit-backdrop-filter": "blur(14px)",
      padding: "7px 14px 8px",
      "border-radius": "999px",
      border: "1px solid rgba(255,255,255,0.10)",
    },
    opacity: [
      [inAt, 0],
      [inAt + 0.3, 1, "inOutSine"],
      [to - 0.4, 1],
      [to - 0.05, 0, "inOutSine"],
    ],
  });
}

export interface FilmTimeline {
  sections: Array<{ id: string; from: number; to: number }>;
}

export async function buildFilm(opts: {
  captions: boolean;
  /** The track (FILM_MUSIC unless an audition picks another). */
  music: FilmMusic;
}): Promise<Composition & { timeline: FilmTimeline }> {
  const m = loadAssets();
  const typed = { clickGain: CLICK_GAIN, keyGain: 0.3 };
  const segs: Placed[] = [];
  const cams: CamKeys[] = [];
  const under: Layer[] = [];
  const overlay: Layer[] = [];
  const captions: Array<[string, number, number]> = [];
  const sections: FilmTimeline["sections"] = [];
  let t = INTRO;
  sections.push({ id: "title", from: 0, to: INTRO });
  const add = (p: Placed): Placed => {
    segs.push(p);
    t = p.to;
    return p;
  };
  /** A Wish's push-in on its prompt while it is typed. */
  const typingPush = (p: Placed, tag = ""): void => {
    cams.push(
      ...pushIn(
        p.rect(`typing${tag}`),
        p.at(`typing${tag}`) + 0.3,
        p.at(`typed${tag}`) + 0.15,
        1.45,
      ),
    );
  };
  /** The VHS look over [a, b] of placed segment `p`. */
  const lapse = (
    p: Placed,
    a: number,
    b: number,
    clock: { from: number; to: number },
  ): void => {
    const look = vhs(a, b, p.layers[0]!, clock);
    under.push(...look.layers);
    overlay.push(...look.overlay);
  };
  const lapseOf = (name: string, from: string, to: string) => ({
    from: recMark(m, name, from),
    to: recMark(m, name, to),
    speed: LAPSE_SPEED,
  });

  /**
   * The Pick UI element button, pushed in on until it is pressed; the camera
   * is back at rest before the hand sets off with the picker on (the
   * recording holds the hand on the button meanwhile) — no camera move while
   * the picker outlines what the hand passes.
   */
  const pickPush = (p: Placed, tag = ""): void => {
    cams.push(
      ...pushIn(
        p.rect(`pick-button${tag}`),
        p.at(`pick-button${tag}`) + 0.15,
        p.at(`picker-on${tag}`) + 0.02,
        2.2,
      ),
    );
  };

  // 1. Pages → Places (one recording: the map Places grows out of is the
  //    same live map through the scene): the user's page about buying a
  //    piano, a Wish, the shops and their map written live, the map's expand
  //    → Places; a shop's detail, then a Wish for opening times on the cards
  //    — a small change to the app, pushed while time passes.
  {
    const p = add(
      place(
        m,
        "pages",
        withLapse(m, "pages", INTRO, lapseOf("pages", "lapse", "lapsed")),
        typed,
      ),
    );
    typingPush(p);
    const placesAt = p.at("places");
    sections.push({ id: "pages", from: INTRO, to: placesAt });
    captions.push(["Agents write with you", p.at("typing") - 1.0, placesAt]);
    pickPush(p, "-hours");
    typingPush(p, "-hours");
    lapse(p, p.at("lapse"), p.at("lapsed"), {
      from: 15 * 60 + 2,
      to: 15 * 60 + 31,
    });
    const card = p.rect("hours");
    // The highlight marks the moment the hours appear (the time-lapse's
    // end), framing the card as it is once they have eased in.
    under.push(glow(card, p.at("lapsed"), p.at("hours") + 1.6));
    cams.push(...pushIn(card, p.at("hours"), p.at("hours") + 1.2, 1.6));
    sections.push({ id: "places", from: placesAt, to: t });
    captions.push(["Evolves on request", p.at("pick-button-hours") - 1.0, t]);
  }

  // 3. Files → Sonata (one recording: the song plays on across the switch),
  //    a Wish for the Current key section (highlighted the moment it
  //    appears), then a Wish for a new app and its conversation.
  {
    const from = t;
    const p = add(
      place(
        m,
        "sonata",
        withLapse(m, "sonata", t, lapseOf("sonata", "lapse", "lapsed")),
        typed,
      ),
    );
    pickPush(p);
    typingPush(p);
    lapse(p, p.at("lapse"), p.at("lapsed"), {
      from: 15 * 60 + 40,
      to: 16 * 60 + 12,
    });
    const sec = onScreen(p.rect("section"));
    const appears = p.at("section-appears");
    under.push(glow(sec, appears, p.at("section") + 1.8));
    // Arrives as the section has eased in; out as the hand opens it.
    cams.push(
      ...pushIn(sec, p.at("section") + 0.2, p.at("section") + 1.0, 1.6),
    );
    typingPush(p, "-create");
    const sonataAt = p.at("sonata") - 0.6;
    const createAt = p.at("typing-create") - 1.4;
    sections.push({ id: "files", from, to: sonataAt });
    sections.push({ id: "sonata", from: sonataAt, to: createAt });
    sections.push({ id: "create", from: createAt, to: t });
    captions.push(["All integrated", from, sonataAt]);
    captions.push(["Evolves on request", sonataAt, createAt]);
    captions.push(["Create any app", createAt, t]);
  }

  // 5. The prototype, "implement it", and Circle arriving in Home.
  {
    const from = t;
    const p = add(
      place(
        m,
        "prototype",
        withLapse(m, "prototype", t, lapseOf("prototype", "lapse", "lapsed")),
        typed,
      ),
    );
    typingPush(p);
    lapse(p, p.at("lapse"), p.at("lapsed"), {
      from: 17 * 60 + 40,
      to: 18 * 60 + 55,
    });
    const tile = p.rect("circle-tile");
    // The highlight marks the moment the tile appears — never earlier (v11
    // drew it a few frames on the empty New app tile before Circle came in).
    under.push(glow(tile, p.at("circle-tile") + 1 / 60, p.to - 0.4));
    // Back out before the segment ends: the pull-back starts at rest.
    cams.push(...pushIn(tile, p.at("circle-tile") + 0.9, p.to - 1.0, 2.0));
    sections.push({ id: "prototype", from, to: t });
    captions.push(["Create any app", from, t]);
  }

  // 6. Desktop: the camera pulls back from the gallery to equin's desktop
  //    mode, where it is the one window. The prototype segment's last frame
  //    (the full-screen gallery) is drawn so it lies exactly on the window's
  //    content, and gives way to the window's own pixels as the camera pulls
  //    back. Then the montage: every app opening in a window of its own, one
  //    beat each, faster and faster — and back to the gallery, full screen.
  const desktopFrom = t;
  const DESK_HOLD = 2.0;
  const knots: Knot[] = [];
  const montageAt = recMark(m, "desktop", "montage");
  let ft = desktopFrom + montageAt;
  const opened = Object.keys(m.sequences.desktop?.input?.marks ?? {}).filter(
    (k) => k.startsWith("opened-"),
  ).length;
  if (opened === 0) throw new Error("promo-film: the desktop opens no app");
  const beats: number[] = [];
  // Each beat is a step: one settled recording frame held, then the next.
  // Steps fall on the film's frame grid and the jump between two takes
  // STEP_EPS, so no film frame ever samples the interpolation between two
  // held frames (it would show the launcher or a window mid-opening — the
  // v5 flicker).
  const FPS = 60;
  const snap = (x: number): number => Math.round(x * FPS) / FPS;
  const STEP_EPS = 1e-4;
  ft = snap(ft);
  // Cut to the music: the track starts where the montage's first window
  // lands on one of its bars, and each window lands on its note grid —
  // sixteenths, or triplets (BeatGrid.subdivision) — (montageIntervals:
  // ~0.7 s slowing to single steps) — the montage
  // plays on the beat. Without a beat grid, the plain frame grid.
  const grid = filmMusicBeat(opts.music);
  const period = grid ? 60 / grid.bpm : 0;
  const bar = 4 * period;
  const musicStart = grid ? (((grid.firstBeat - ft) % bar) + bar) % bar : 0;
  const SIXTEENTH = grid ? period / (grid.subdivision ?? 4) : 60 / 172 / 4;
  /** `x` on the music's note grid (film time), then on the frame grid. */
  const onGrid = (x: number, q = SIXTEENTH): number => {
    if (!grid) return snap(x);
    const origin = grid.firstBeat - musicStart;
    return snap(origin + Math.round((x - origin) / q) * q);
  };
  knots.length = 0;
  knots.push([desktopFrom, 0], [ft, montageAt]);
  // The accumulation, timed in seconds and cut on the music's note grid: a
  // few readable beats that set the pattern, then each interval ~0.7× the
  // one before — well past the point where the eye stops counting — the
  // focal window and Home's cut on that same cadence, no hold between them.
  const intervals = montageIntervals(opened, SIXTEENTH);
  console.log(
    `montage: ${intervals.join(" ")} steps of ${SIXTEENTH.toFixed(4)} s (1/${grid?.subdivision ?? 4} beat)`,
  );
  for (let i = 0; i < opened; i++) {
    const r = recMark(m, "desktop", `opened-${i}`);
    knots.push([ft + STEP_EPS, r]);
    beats.push(ft);
    const beat = intervals[i]! * SIXTEENTH;
    ft = Math.max(snap(ft + 1 / FPS), onGrid(ft + beat));
    knots.push([ft, r + 0.001]);
  }
  const back = recMark(m, "desktop", "home-focused");
  // Home's window raised over the mosaic — the cut after the focal window,
  // on the same grid — and from there real time: the hand (drawn from this
  // cut on) reaches its Full screen control and the gallery grows into the
  // whole screen with the window's own motion (the camera lands on the
  // opening's framing with it — below).
  // Held on the gallery; the end card's fade (0.6 s before the hold ends)
  // falls on a beat.
  const backAt = ft;
  const settled = recMark(m, "desktop", "fullscreen-settled") - back;
  const GALLERY_HOLD = 1.7;
  const END_HOLD = grid
    ? onGrid(ft + settled + GALLERY_HOLD - 0.6, period) + 0.6 - ft
    : settled + GALLERY_HOLD;
  beats.push(backAt);
  knots.push([ft + STEP_EPS, back], [ft + END_HOLD, back + END_HOLD]);
  const desk = place(m, "desktop", knots, { cursor: { fromRec: back } });
  segs.push(desk);
  // `home-frame` is where the full-screen gallery lies on the desktop: the
  // window shows the same gallery, the same size, in a smaller box (its
  // layout is centred and top-anchored, so it is the full-screen one cropped
  // to the window's content), so the gallery drawn there — overflowing the
  // window — matches the window's own pixels wherever they overlap.
  const frameIn: Rect = { x: 0, y: 0, width: W, height: H };
  const frameOut = desk.rect("home-frame");
  const k = frameOut.height / frameIn.height;
  const box: Rect = {
    x: frameOut.x - frameIn.x * k,
    y: frameOut.y - frameIn.y * k,
    width: W * k,
    height: H * k,
  };
  const pulled = desktopFrom + DESK_HOLD;
  const lastProto: Layer = {
    kind: "image",
    still: "prototype-last",
    start: desktopFrom,
    end: pulled,
    origin: [0, 0],
    x: box.x,
    y: box.y,
    scale: k,
    // Gone while the camera has only begun to pull back: the frame overflows
    // the window, so its edges would otherwise show as a dim rectangle
    // shrinking over the wallpaper (v10's first render).
    opacity: [
      [desktopFrom + 0.15, 1],
      [desktopFrom + 0.7, 0, "inOutSine"],
    ],
  };
  const inside: CameraView = {
    focus: [box.x + box.width / 2, box.y + box.height / 2],
    zoom: 1 / k,
  };
  cams.push({
    focus: [[desktopFrom, inside.focus, "step"]],
    zoom: [[desktopFrom, inside.zoom, "step"]],
  });
  cams.push(
    cameraMove(desktopFrom + 0.3, pulled, inside, REST, {
      stage: STAGE,
      easing: { bezier: [0.3, 0, 0.2, 1] },
    }),
  );
  // The ending lands on the opening's very framing. The desktop's screen is
  // 1.5× the film's in CSS px, so its full-screen gallery shows the same
  // layout smaller, with more room around it; `gallery-frame` is where the
  // film's own screen (W × H CSS px) lies in it — centred and top-anchored,
  // like the layout. As the window grows into the screen with its own
  // motion, the camera pushes in on that box in the same movement (the
  // mirror of the opening pull-back), so the held gallery is the opening's:
  // the same size, the same place, the hand where it rested at the start.
  // The desktop records at the stage's pixel density (DESK.dpr), so the
  // landing is as sharp as the opening; the hand keeps its size on screen.
  {
    const gf = desk.rect("gallery-frame");
    const opening: CameraView = {
      focus: [gf.x + gf.width / 2, gf.y + gf.height / 2],
      zoom: W / gf.width,
    };
    // From the click's release (the growth starts on it) and shaped like the growth —
    // an ease-out, most of the push while the window is still growing
    // (220 ms), then a short settle: one movement, not a growth followed by
    // a zoom (a slow-start ease-in-out lagged the window by a full beat).
    const fsMark = recMark(m, "desktop", "fullscreen");
    const press = m.sequences.desktop?.input?.clicks
      .filter((c) => c.t <= fsMark + 1e-6)
      .at(-1);
    if (!press)
      throw new Error("promo-film: no click on Home's Full screen control");
    const at = desk.film(press.upAt);
    const grow = cameraMove(at, at + 0.5, REST, opening, {
      stage: STAGE,
      easing: { bezier: [0.2, 0.7, 0.3, 1] },
    });
    cams.push(grow);
    const hand = desk.layers[1];
    if (!hand) throw new Error("promo-film: the desktop draws no hand");
    desk.layers[1] = {
      ...hand,
      scale: grow.zoom.map(([t, z]): Key => [t, 1 / z]),
    } as Layer;
  }
  // Each new window lands with a soft tick, the beat of the accumulation.
  const montageSfx: SfxCue[] = beats.map((at): SfxCue => ({
    kind: "click",
    at,
    hold: 0.03,
    gain: CLICK_GAIN * 0.5,
  }));
  const desktopTo = desk.to;
  sections.push({ id: "desktop", from: desktopFrom, to: desktopTo });

  // 7. The pause on the gallery (the segment's own last seconds), then a
  //    direct fade to the end card.
  const scenes: Scene[] = [];
  const endAt = desktopTo - 0.6;
  const duration = endAt + 4.8;
  scenes.push(outro({ end: endAt, duration }));
  sections.push({ id: "end", from: endAt, to: duration });
  desk.layers[0] = { ...desk.layers[0]!, end: endAt + 0.6 } as Layer;
  // The title fades into the session (from INTRO) while its words are still
  // leaving; its growth and its leaving land on the music's beats.
  const title = titleCard({
    sessionAt: INTRO,
    onBeat: (x) => onGrid(x, period || 1 / FPS),
  });
  scenes.unshift(title.scene);

  // Music: in from near silence, never stopped, out at the end.
  const resolved = await resolveFilmMusic(opts.music);
  const music = {
    ...resolved,
    sectionStart: resolved.sectionStart + musicStart,
  };
  console.log(
    `music: ${resolved.file} from ${music.sectionStart.toFixed(2)} s; the film ends ${(music.sectionStart + duration).toFixed(2)} s into it`,
  );
  const gainDb: Key[] = [
    [0, -26],
    [0.9, 0, "outSine"],
    [endAt + 1.2, 0],
    [duration, -32, "inSine"],
  ];

  const cam = mergeCam([
    ...cams.map((c): Scene => ({ layers: [], cam: c })),
    ...scenes,
  ]);
  const sfx: SfxCue[] = [
    ...segs.flatMap((p) => p.sfx),
    ...scenes.flatMap((sc) => sc.sfx ?? []),
    ...montageSfx,
  ];

  return {
    width: W,
    height: H,
    duration,
    background: "#000",
    assets: { dir: REC_DIR, manifest: m },
    // No motion blur (media/film's default): it snapped on and off mid-move
    // — v20/v21's Pick UI pull-back at 27.4 s / 27.8 s went crisp → smeared
    // → crisp in one frame each way, read as a shake.
    camera: { ...cam, motionBlur: false },
    // Each segment's frames, then (above them, under its pointer) the lapse
    // fringes and the glows.
    layers: [
      ...segs.flatMap((p) => [p.layers[0]!]),
      ...under,
      lastProto,
      ...segs.flatMap((p) => p.layers.slice(1)),
    ],
    overlay: [
      ...overlay,
      ...scenes.flatMap((sc) => sc.overlay ?? []),
      ...(opts.captions
        ? captions.map(([str, a, b]) => caption(str, a, b))
        : []),
    ],
    audio: {
      music: { ...music, gainDb },
      clips: [],
      sfx: sfx
        .filter((c) => c.at >= 0 && c.at < duration)
        .sort((a, b) => a.at - b.at),
    },
    timeline: { sections },
  };
}
