// The whole film, from the recordings (record.ts): one continuous session of
// the real app, ending on equin's desktop mode, then a short tail (open
// source, the end card). The timeline is derived from the recordings — each
// segment plays at its real speed except its time-lapse — so re-recording a
// segment re-times everything after it. The camera is static on the app
// except a push-in on the Wish prompt while it is typed, each framed so the
// prompt is never cropped, on every frame of the move too.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cameraMove,
  frameOn,
  html,
  text,
  type AssetManifest,
  type AudioClip,
  type CameraView,
  type Composition,
  type Key,
  type Layer,
  type PlacedClip,
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
import { resolveFilmMusic } from "./music";
import { outro } from "./outro";
import {
  place,
  recDuration,
  recMark,
  recRect,
  type Knot,
  type Placed,
} from "./place";
import { SEGMENTS } from "./segments";
import { readSegmentFacts, REC_DIR } from "./session-kit";

/** How much faster than real time the time-lapses run. */
const LAPSE_SPEED = 5;
/** The sample-loading wait after Sonata's first Play (a still picture) runs this much faster. */
const STALL_SPEED = 6;
const STAGE = { width: W, height: H };
const REST: CameraView = { focus: CENTER, zoom: 1 };

/**
 * The film's sections — set this to end on the desktop (drop the open-source
 * card and the end card): `true` keeps them as a short tail.
 */
const TAIL = true;

/** The recordings, as one manifest (each recording's last frame also a still). */
function loadAssets(): { m: AssetManifest; sonata: AudioClip } {
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
    m.sequences[name] = seq;
    const last = seq.frames[seq.frames.length - 1];
    if (!last) throw new Error(`promo-film: "${name}" has no frame`);
    m.stills[`${name}-last`] = { file: last, x: 0, y: 0, width: W, height: H };
  }
  const sonataFile = join(REC_DIR, "sonata-piano.json");
  if (!existsSync(sonataFile))
    throw new Error("promo-film: no Sonata sound — re-record `integrated`");
  const sonata = JSON.parse(readFileSync(sonataFile, "utf8")) as AudioClip;
  m.audio.sonata = { file: sonata.file, duration: sonata.duration };
  return { m, sonata };
}

/** A push-in on `r` (whole, plus a margin) from `inAt`, back out from `outAt` — never cutting it. */
function pushIn(
  r: Rect,
  inAt: number,
  outAt: number,
  maxZoom: number,
  dur = 0.6,
): CamKeys[] {
  const v = frameOn(r, { stage: STAGE, margin: 32, maxZoom });
  return [
    cameraMove(inAt, inAt + dur, REST, v, { stage: STAGE, keep: r }),
    cameraMove(outAt, outAt + dur, v, REST, { stage: STAGE, keep: r }),
  ];
}

/** The time-lapse look over [a, b]: a vignette closing in and a fast-forward mark, eased in and out. */
function lapseLook(a: number, b: number): Layer[] {
  const op: Key[] = [
    [a, 0],
    [a + 0.18, 1, "outSine"],
    [b - 0.18, 1],
    [b, 0, "inSine"],
  ];
  return [
    html(
      `<div style="width:${W}px;height:${H}px;background:radial-gradient(ellipse 75% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)"></div>`,
      W,
      H,
      { start: a, end: b, opacity: op },
    ),
    html(
      `<div style="display:flex;align-items:center;justify-content:center;width:64px;height:40px;border-radius:999px;background:rgba(12,14,20,0.62);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.14)"><svg width="26" height="18" viewBox="0 0 26 18"><path d="M1 1l11 8-11 8z M13 1l11 8-11 8z" fill="rgba(255,255,255,0.92)"/></svg></div>`,
      64,
      40,
      { start: a, end: b, x: W / 2 - 32, y: H - 72, opacity: op },
    ),
  ];
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

/**
 * Knots for a recording placed at film `t`: real speed, except each lapse
 * ([`from`, `to`], recording seconds, in order) played `speed`× faster.
 */
function withLapse(
  m: AssetManifest,
  name: string,
  t: number,
  ...lapses: Array<{ from: number; to: number; speed: number } | undefined>
): Knot[] {
  const D = recDuration(m, name);
  const knots: Knot[] = [[t, 0]];
  let film = t;
  let rec = 0;
  for (const l of lapses) {
    if (!l) continue;
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

export interface FilmTimeline {
  sections: Array<{ id: string; from: number; to: number }>;
}

export async function buildFilm(opts: {
  captions: boolean;
}): Promise<Composition & { timeline: FilmTimeline }> {
  const { m, sonata } = loadAssets();
  const sound = { clickGain: CLICK_GAIN };
  const typed = { clickGain: CLICK_GAIN, keyGain: 0.3 };
  const segs: Placed[] = [];
  const cams: CamKeys[] = [];
  const overlay: Layer[] = [];
  const clips: PlacedClip[] = [];
  const captions: Array<[string, number, number]> = [];
  const sections: FilmTimeline["sections"] = [];
  let t = 0;
  const add = (p: Placed): Placed => {
    segs.push(p);
    t = p.to;
    return p;
  };
  /** A Wish's typing push-in, its time-lapse look. */
  const wishBeats = (p: Placed, lapseTo: number): void => {
    cams.push(
      ...pushIn(
        p.rect("typing"),
        p.at("typing") - 0.5,
        p.at("typed") + 0.15,
        1.45,
      ),
    );
    overlay.push(...lapseLook(p.at("lapse"), lapseTo));
  };

  // 1. Home → Pages → the conversation → Files → Sonata plays the piece.
  const playUpRec = (() => {
    const tPlay = recMark(m, "integrated", "playing");
    const click = m.sequences.integrated?.input?.clicks
      .filter((c) => c.t <= tPlay)
      .at(-1);
    if (!click) throw new Error("promo-film: no Play click in integrated");
    return click.upAt;
  })();
  const { playheadAtEnd } = readSegmentFacts("integrated");
  if (playheadAtEnd === undefined)
    throw new Error("promo-film: integrated has no playheadAtEnd fact");
  const startedRec = recMark(m, "integrated", "clock-read") - playheadAtEnd;
  const stalled = startedRec - playUpRec > 0.4;
  const integrated = add(
    place(
      m,
      "integrated",
      withLapse(
        m,
        "integrated",
        0,
        stalled
          ? {
              from: playUpRec + 0.15,
              to: startedRec - 0.05,
              speed: STALL_SPEED,
            }
          : undefined,
      ),
      sound,
    ),
  );
  sections.push({ id: "integrated", from: 0, to: t });
  captions.push(["All integrated", integrated.at("piano") - 0.3, t]);
  const sonataAt = integrated.film(startedRec);
  const pausedAt = integrated.at("paused");
  clips.push({
    audio: "sonata",
    at: sonataAt,
    duration: Math.min(sonata.duration, pausedAt - sonataAt + 0.1),
    fadeOut: 0.12,
  });

  // 2. A Wish in Sonata: the Current key section, shown by the agent's config
  //    change; then the launcher to Chord, and to Pages.
  {
    const from = t;
    const L0 = recMark(m, "sonata", "lapse");
    const L1 = recMark(m, "sonata", "lapsed");
    const p = add(
      place(
        m,
        "sonata",
        withLapse(m, "sonata", t, { from: L0, to: L1, speed: LAPSE_SPEED }),
        typed,
      ),
    );
    wishBeats(p, p.at("lapsed"));
    sections.push({ id: "sonata", from, to: p.at("chord-grid") - 0.8 });
    sections.push({ id: "tour", from: p.at("chord-grid") - 0.8, to: t });
    captions.push(["Evolves on request", from, p.at("chord-grid") - 0.8]);
    captions.push(["Any app", p.at("chord-grid") - 0.8, t]);
  }

  // 3. Lisbon: a Wish for holiday ideas, the map the agent adds, Places
  //    zooming out over every saved place — then, from there, a Wish for a
  //    new app (its time-lapse cuts to the prototype it made).
  {
    const from = t;
    const L0 = recMark(m, "lisbon", "lapse");
    const L1 = recMark(m, "lisbon", "lapsed");
    const D = recDuration(m, "lisbon");
    const S = recMark(m, "lisbon", "submitted-create") + 0.35;
    const p = add(
      place(
        m,
        "lisbon",
        withLapse(
          m,
          "lisbon",
          t,
          { from: L0, to: L1, speed: LAPSE_SPEED },
          { from: S, to: D, speed: LAPSE_SPEED },
        ),
        typed,
      ),
    );
    wishBeats(p, p.at("lapsed"));
    cams.push(
      ...pushIn(
        p.rect("typing-create"),
        p.at("typing-create") - 0.5,
        p.at("typed-create") + 0.15,
        1.45,
      ),
    );
    overlay.push(...lapseLook(p.film(S), p.to + 0.25));
    sections.push({ id: "lisbon", from, to: p.at("typing-create") - 1.4 });
    captions.push(["Evolves on request", from, p.at("typing-create") - 1.4]);
    sections.push({ id: "create", from: p.at("typing-create") - 1.4, to: t });
    captions.push(["Create any app", p.at("typing-create") - 1.4, t]);
  }

  // 4. The prototype the Wish made, and a new Wish to build it.
  {
    const from = t;
    const P = recDuration(m, "prototype");
    const L0 = recMark(m, "prototype", "lapse");
    const pr = add(
      place(
        m,
        "prototype",
        withLapse(m, "prototype", t, { from: L0, to: P, speed: LAPSE_SPEED }),
        typed,
      ),
    );
    wishBeats(pr, pr.to);
    sections.push({ id: "prototype", from, to: t });
    captions.push(["Create any app", from, t]);
  }

  // 5. Desktop: the camera pulls back from Circle to equin's desktop mode,
  //    where it is a window showing the same canvas (driven there off
  //    camera). The prototype's last frame is drawn so its phone lies exactly
  //    on the window's phone, and gives way to the window's own pixels as the
  //    camera pulls back — the one invented transition of the film.
  const desktopFrom = t;
  const DESK_HOLD = 1.8;
  const desk = place(m, "desktop", withLapse(m, "desktop", t), {
    cursor: false,
  });
  segs.push(desk);
  const phoneIn = recRect(m, "prototype", "phone");
  const phoneOut = desk.rect("phone");
  const k = phoneOut.height / phoneIn.height;
  const box: Rect = {
    x: phoneOut.x - phoneIn.x * k,
    y: phoneOut.y - phoneIn.y * k,
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
    opacity: [
      [desktopFrom + 0.35, 1],
      [desktopFrom + 0.95, 0, "inOutSine"],
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
  const desktopTo = desk.to;
  sections.push({ id: "desktop", from: desktopFrom, to: desktopTo });

  // 6. The tail: open source, then the end card.
  const scenes: Scene[] = [];
  let duration = desktopTo;
  let endAt = desktopTo;
  if (TAIL) {
    const github = desktopTo;
    endAt = github + 2.2;
    duration = endAt + 3.4;
    scenes.push(outro({ github, end: endAt, duration }));
    sections.push(
      { id: "open-source", from: github, to: endAt },
      { id: "end", from: endAt, to: duration },
    );
  }
  // The desktop holds under the open-source card while it fades in.
  desk.layers[0] = { ...desk.layers[0]!, end: desktopTo + 0.6 } as Layer;

  // Music: in from near silence, ducked (never stopped) under Sonata's piano,
  // out at the end.
  const music = await resolveFilmMusic();
  const gainDb: Key[] = [
    [0, -26],
    [0.9, 0, "outSine"],
    [sonataAt - 0.35, 0],
    [sonataAt, -13, "inOutSine"],
    [pausedAt, -13],
    [pausedAt + 0.4, 0, "inOutSine"],
    [Math.max(pausedAt + 0.5, endAt + 1.2), 0],
    [duration, -32, "inSine"],
  ];

  const cam = mergeCam([
    ...cams.map((c): Scene => ({ layers: [], cam: c })),
    ...scenes,
  ]);
  const sfx: SfxCue[] = [
    ...segs.flatMap((p) => p.sfx),
    ...scenes.flatMap((sc) => sc.sfx ?? []),
  ];

  return {
    width: W,
    height: H,
    duration,
    background: "#000",
    assets: { dir: REC_DIR, manifest: m },
    camera: { ...cam, motionBlur: { cap: 2, gain: 0.03 } },
    layers: [...segs.flatMap((p) => p.layers), lastProto],
    overlay: [
      // The intro: up from black onto Home.
      {
        kind: "shape",
        shape: { kind: "rect", width: W, height: H, fill: "#000" },
        end: 0.7,
        opacity: [
          [0, 1],
          [0.7, 0, "inOutSine"],
        ],
      },
      ...overlay,
      ...scenes.flatMap((sc) => sc.overlay ?? []),
      ...(opts.captions
        ? captions.map(([str, a, b]) => caption(str, a, b))
        : []),
    ],
    audio: {
      music: { ...music, gainDb },
      clips,
      sfx: sfx
        .filter((c) => c.at >= 0 && c.at < duration)
        .sort((a, b) => a.at - b.at),
    },
    timeline: { sections },
  };
}
