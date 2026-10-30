// A small test film for the engine: synthetic assets it generates itself
// (coloured PNG "app" stills with named rects, a typing sequence, an audio
// clip and a music bed), exercising a 3D tilted card under a light sweep, a
// camera punch-in with spotlight and ring, a crop-lift of one rect into its own
// layer, a cursor click, a typing sequence with key ticks, a per-letter text
// reveal, a clip-path wipe, SFX and a silence gap in the music.
//
//   ./equin run plugins/media/plugins/film/e2e/demo.ts --preview
//   ./equin run plugins/media/plugins/film/e2e/demo.ts --stills 1,4,6,8.5,10.5
//   ./equin run plugins/media/plugins/film/e2e/demo.ts            # 1080p60 → /tmp/film/demo.mp4

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  center,
  cropLift,
  fade,
  group,
  image,
  rectOf,
  rectV,
  ring,
  runFilm,
  sequence,
  shape,
  text,
  typing,
  type AssetManifest,
  type Composition,
  type Rect,
  type SfxCue,
} from "./index";

const DIR = join(tmpdir(), "film", "demo", "assets");
const DPR = 2;

// ------------------------------------------------------------------ PNG ----

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A canvas of RGB pixels with just enough drawing for app-like stills. */
class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: [number, number, number],
  ) {
    this.px = new Uint8Array(w * h * 3);
    this.fill({ x: 0, y: 0, width: w / DPR, height: h / DPR }, bg, 0);
  }
  /** A rounded rect in CSS px, with a vertical gradient to `to`. */
  fill(r: Rect, c: [number, number, number], radius: number, to = c): void {
    const x0 = Math.round(r.x * DPR);
    const y0 = Math.round(r.y * DPR);
    const x1 = Math.round((r.x + r.width) * DPR);
    const y1 = Math.round((r.y + r.height) * DPR);
    const rad = radius * DPR;
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) {
      const u = (y - y0) / Math.max(1, y1 - y0);
      for (let x = Math.max(0, x0); x < Math.min(this.w, x1); x++) {
        const dx = Math.max(x0 + rad - x - 0.5, 0, x + 0.5 - (x1 - rad));
        const dy = Math.max(y0 + rad - y - 0.5, 0, y + 0.5 - (y1 - rad));
        const a =
          rad < 0.5
            ? 1
            : Math.max(0, Math.min(1, rad + 0.5 - Math.hypot(dx, dy)));
        if (a <= 0) continue;
        const i = (y * this.w + x) * 3;
        for (let k = 0; k < 3; k++) {
          const v =
            (c[k] as number) + ((to[k] as number) - (c[k] as number)) * u;
          this.px[i + k] = Math.round(
            (this.px[i + k] as number) * (1 - a) + v * a,
          );
        }
      }
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.px.subarray(y * this.w * 3, (y + 1) * this.w * 3)).copy(
        raw,
        y * (this.w * 3 + 1) + 1,
      );
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]);
  }
}

/** 48 kHz mono 16-bit WAV from a sample function. */
function wav(seconds: number, f: (t: number) => number): Buffer {
  const SR = 48000;
  const n = Math.round(seconds * SR);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, f(i / SR))) * 32767),
      44 + i * 2,
    );
  return b;
}

// --------------------------------------------------------------- assets ----

const PROMPT = "make it bigger";

function makeAssets(): { manifest: AssetManifest; music: string } {
  mkdirSync(DIR, { recursive: true });
  const rects: Record<string, Rect> = {};
  // "home": a gallery of six cards on a dark page.
  const home = new Canvas(1280 * DPR, 720 * DPR, [14, 16, 24]);
  home.fill({ x: 0, y: 0, width: 1280, height: 56 }, [24, 27, 38], 0);
  home.fill({ x: 24, y: 18, width: 120, height: 20 }, [90, 110, 220], 6);
  const colors: Array<[number, number, number]> = [
    [229, 92, 92],
    [240, 170, 60],
    [80, 190, 120],
    [70, 150, 230],
    [150, 100, 220],
    [220, 90, 170],
  ];
  colors.forEach((c, i) => {
    const r = {
      x: 80 + (i % 3) * 384,
      y: 110 + Math.floor(i / 3) * 300,
      width: 352,
      height: 260,
    };
    rects[`card-${i + 1}`] = r;
    home.fill(r, c, 18, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6]);
    home.fill(
      { x: r.x + 24, y: r.y + r.height - 60, width: 180, height: 16 },
      [250, 250, 255],
      8,
    );
    home.fill(
      { x: r.x + 24, y: r.y + r.height - 34, width: 120, height: 10 },
      [235, 235, 245],
      5,
    );
  });
  writeFileSync(join(DIR, "home.png"), home.png());
  // "panel": a light pane with a prompt field.
  const panel = new Canvas(720 * DPR, 440 * DPR, [246, 247, 250]);
  panel.fill({ x: 0, y: 0, width: 720, height: 52 }, [230, 232, 240], 0);
  panel.fill({ x: 20, y: 16, width: 200, height: 20 }, [60, 70, 100], 6);
  panel.fill({ x: 40, y: 100, width: 640, height: 220 }, [225, 228, 238], 14);
  const field: Rect = { x: 60, y: 350, width: 600, height: 56 };
  rects["field"] = {
    x: 300 + field.x,
    y: 140 + field.y,
    width: field.width,
    height: field.height,
  };
  panel.fill(field, [255, 255, 255], 12);
  writeFileSync(join(DIR, "panel.png"), panel.png());
  // "prompt": the field typing PROMPT, one frame per character.
  const frames: string[] = [];
  for (let i = 0; i <= PROMPT.length; i++) {
    const f = new Canvas(
      field.width * DPR,
      field.height * DPR,
      [255, 255, 255],
    );
    for (let k = 0; k < i; k++) {
      if (PROMPT[k] !== " ")
        f.fill(
          { x: 18 + k * 13, y: 18, width: 10, height: 20 },
          [40, 44, 60],
          2,
        );
    }
    f.fill({ x: 18 + i * 13, y: 16, width: 2, height: 24 }, [70, 120, 240], 1);
    const name = `prompt-${String(i).padStart(2, "0")}.png`;
    writeFileSync(join(DIR, name), f.png());
    frames.push(name);
  }
  // A short tone the film places as a clip.
  writeFileSync(
    join(DIR, "blip.wav"),
    wav(0.6, (t) => 0.3 * Math.sin(2 * Math.PI * 660 * t) * Math.exp(-t * 6)),
  );
  // A music bed: a soft A-minor pad with a pulse, 16 s.
  const music = join(tmpdir(), "film", "demo", "music.wav");
  const notes = [220, 261.63, 329.63, 440];
  writeFileSync(
    music,
    wav(16, (t) => {
      const pulse = 0.6 + 0.4 * Math.exp(-((t * 2) % 1) * 5);
      return (
        notes.reduce(
          (s, f, i) => s + Math.sin(2 * Math.PI * f * t + i) * 0.06,
          0,
        ) *
        pulse *
        Math.min(1, t * 2)
      );
    }),
  );
  const manifest: AssetManifest = {
    dpr: DPR,
    width: 1280,
    height: 720,
    stills: {
      home: { file: "home.png", x: 0, y: 0, width: 1280, height: 720 },
      panel: { file: "panel.png", x: 300, y: 140, width: 720, height: 440 },
    },
    rects,
    sequences: {
      prompt: { frames, clip: rects["field"] as Rect, text: PROMPT },
    },
    strips: {},
    stripRects: {},
    audio: { blip: { file: "blip.wav", duration: 0.6 } },
  };
  writeFileSync(join(DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, music };
}

// ----------------------------------------------------------------- film ----

await runFilm({
  name: "demo",
  out: join(tmpdir(), "film", "demo.mp4"),
  flags: { captions: "adds a caption line over the last scene" },
  build(ctx): Composition {
    const { manifest: m, music } = makeAssets();
    const card2 = rectOf(m, "card-2");
    const card3 = rectOf(m, "card-3");
    const field = rectOf(m, "field");
    const ty = typing(m, "prompt", 7.3, 8.6);
    const sfx: SfxCue[] = [
      { kind: "whoosh", at: 2.9, dur: 0.7, dir: "up" },
      { kind: "pop", at: 4.95, pitch: 2 },
      { kind: "tick", at: 3.6 },
      { kind: "click", at: 7.0 },
      ...ty.cues,
      { kind: "chime", at: 9.6 },
      { kind: "impact", at: 10.2, gain: 0.8 },
    ];
    return {
      width: 1280,
      height: 720,
      duration: 12,
      background: "#05060a",
      assets: { dir: DIR, manifest: m },
      camera: {
        space: "home",
        focus: [
          [0, [640, 360]],
          [3, [640, 360]],
          [4.2, center(card2), "inOutCubic"],
          [5, center(card2)],
          [6.0, [640, 360], "inOutCubic"],
        ],
        zoom: [
          [0, 0.82],
          [3, 0.9, "outSine"],
          [4.2, 2.1, "inOutCubic"],
          [5, 2.1],
          [6.0, 1, { spring: { bounce: 0.15 } }],
        ],
        tiltX: [
          [0, 8],
          [3, 0, "inOutSine"],
        ],
      },
      layers: [
        group(
          [
            image("home", {
              id: "home",
              rotateX: [
                [0, 22],
                [2.8, 0, "inOutCubic"],
              ],
              rotateZ: [
                [0, -4],
                [2.8, 0, "inOutCubic"],
              ],
              radius: 18,
              shadow: "0 40px 120px rgba(0,0,0,.6)",
              opacity: fade(0.1, 0.9, 6.8, 0.4),
            }),
            // The light sweep across the tilted card.
            shape(
              {
                kind: "sweep",
                width: 1280,
                height: 720,
                progress: [
                  [0.4, 0],
                  [2.6, 1, "inOutSine"],
                ],
                radius: 18,
              },
              {
                blend: "screen",
                rotateX: [
                  [0, 22],
                  [2.8, 0, "inOutCubic"],
                ],
                rotateZ: [
                  [0, -4],
                  [2.8, 0, "inOutCubic"],
                ],
                end: 3,
              },
            ),
            // Spotlight + ring on card 2 while the camera is in.
            shape(
              {
                kind: "spotlight",
                hole: rectV(card2),
                radius: 18,
                feather: 20,
              },
              { opacity: fade(4.0, 0.3, 5.2, 0.4), start: 3.9, end: 6 },
            ),
            ring(card2, {
              pad: 6,
              radius: 22,
              opacity: fade(4.1, 0.25, 5.2, 0.4),
              start: 4,
              end: 6,
            }),
            // Card 3 lifted off the page: it rises toward the viewer and floats.
            cropLift(m, "home", card3, {
              id: "lift",
              start: 5,
              end: 7.2,
              z: [
                [5.1, 0],
                [5.8, 140, "outCubic"],
              ],
              rotateY: [
                [5.1, 0],
                [6.6, -14, "inOutSine"],
              ],
              radius: 18,
              shadow: "0 30px 60px rgba(0,0,0,.55)",
              opacity: fade(5, 0.01, 6.8, 0.4),
            }),
          ],
          { width: 1280, height: 720, perspective: 1100 },
        ),
        // The panel, its typing field and a cursor.
        image("panel", {
          x: 300,
          y: [
            [6.5, 760],
            [7.0, 140, { spring: { bounce: 0.2 } }],
          ],
          start: 6.5,
          radius: 16,
          shadow: "0 30px 80px rgba(0,0,0,.5)",
          // The clip-path wipe: the panel is wiped away right to left.
          clipInset: [
            [9.2, [0, 0, 0, 0]],
            [10.0, [0, 720, 0, 0], "inOutCubic"],
          ],
          clipRadius: 16,
        }),
        sequence("prompt", {
          x: field.x,
          y: field.y,
          frame: ty.frame,
          start: 7.0,
          end: 10,
          clipInset: [
            [9.2, [0, 0, 0, 0]],
            [10.0, [0, 600, 0, 0], "inOutCubic"],
          ],
        }),
        shape(
          { kind: "cursor", clicks: [7.0] },
          {
            x: [
              [6.6, 1100],
              [6.95, field.x + 80, "inOutCubic"],
            ],
            y: [
              [6.6, 680],
              [6.95, field.y + 30, "inOutCubic"],
            ],
            start: 6.6,
            end: 9.2,
          },
        ),
      ],
      overlay: [
        text("Make anything.", {
          size: 88,
          weight: 700,
          width: 1280,
          align: "center",
          y: 300,
          start: 9.6,
          reveal: {
            by: "letter",
            at: 9.7,
            stagger: 0.045,
            duration: 0.6,
            fromY: 30,
            fromBlur: 12,
          },
        }),
        ...(ctx.flag("captions")
          ? [
              text("A test film", {
                size: 22,
                weight: 500,
                color: "rgba(255,255,255,.7)",
                x: 60,
                y: 660,
                opacity: fade(9.8, 0.5),
              }),
            ]
          : []),
        // Fade to black.
        shape(
          { kind: "rect", width: 1280, height: 720, fill: "#000" },
          {
            opacity: [
              [11.2, 0],
              [12, 1, "inSine"],
            ],
          },
        ),
      ],
      audio: {
        music: {
          file: music,
          sectionStart: 0,
          gainDb: [
            [0, -40],
            [1.5, -6, "outSine"],
            [4.0, -6],
            [4.4, -16],
            [8.8, -16],
            [9.0, -120, "linear"],
            [9.6, -120],
            [9.7, -6],
            [11.2, -6],
            [12, -60, "inSine"],
          ],
        },
        clips: [{ audio: "blip", at: 5.0, gainDb: -6 }],
        sfx,
      },
    };
  },
});
