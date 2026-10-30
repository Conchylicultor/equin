// The whole film: every section's scene composed into one Composition — one
// camera, layers in scene order (underlays below), the caption layer for the
// `--captions` variant, and the sound (music bed with its silences, Sonata's
// own clip, the SFX).

import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { downloadedFile } from "@plugins/infra/plugins/deps/plugins/download/deps";
import {
  loadManifest,
  text,
  type AssetManifest,
  type Composition,
  type Key,
  type Layer,
} from "@plugins/media/plugins/film/e2e";
import { PROMO_MUSIC, promoMusic } from "../../deps";
import { create } from "./create";
import { desktop, REVEAL_AT, SILENCE_AT } from "./desktop";
import { evolving } from "./evolving";
import { iceberg, macShrink } from "./iceberg";
import { integrated, SONATA_PLAY } from "./integrated";
import { intro } from "./intro";
import { mac } from "./mac";
import { moreApps } from "./more-apps";
import { mergeCam, SITE, type Scene } from "./kit";
import { outro } from "./outro";
import { DURATION, SECTION_LIST, SECTIONS } from "./timeline";

export const ASSETS_DIR = "/tmp/equin-film/assets";

/** The manifest, with Sonata's timed sequence trimmed to the frames the film shows (each frame is a decoded 2560×1440 image). */
function filmManifest(): AssetManifest {
  const m = loadManifest(ASSETS_DIR);
  const seq = m.sequences["sonata-play"];
  if (!seq?.fps) throw new Error("promo-film: no timed sonata-play sequence");
  const shown = Math.ceil((SECTIONS.integrated.to - SONATA_PLAY) * seq.fps) + 2;
  if (seq.frames.length < shown)
    throw new Error(
      `promo-film: sonata-play has ${seq.frames.length} frames, the film shows ${shown}`,
    );
  return {
    ...m,
    sequences: {
      ...m.sequences,
      "sonata-play": { ...seq, frames: seq.frames.slice(0, shown) },
    },
  };
}

function captionLayers(): Layer[] {
  return SECTION_LIST.flatMap((s) => {
    if (s.caption === null) return [];
    const inAt = s.from + 0.35;
    const outAt = s.to - 0.45;
    return [
      text(s.caption, {
        size: 19,
        weight: 500,
        color: "rgba(255,255,255,0.92)",
        letterSpacing: "-0.005em",
        x: 40,
        y: 650,
        start: inAt,
        end: s.to,
        style: {
          "text-shadow": "0 1px 2px rgba(0,0,0,0.35)",
          background: "rgba(12,14,20,0.55)",
          "backdrop-filter": "blur(14px)",
          "-webkit-backdrop-filter": "blur(14px)",
          padding: "7px 14px 8px",
          "border-radius": "999px",
          border: "1px solid rgba(255,255,255,0.10)",
        },
        reveal: {
          by: "word",
          at: inAt,
          stagger: 0.08,
          duration: 0.6,
          fromY: 8,
          fromBlur: 6,
        },
        opacity: [
          [inAt, 0],
          [inAt + 0.3, 1, "inOutSine"],
          [outAt, 1],
          [s.to - 0.05, 0, "inOutSine"],
        ],
      }),
    ];
  });
}

/** Music gain (dB): fade in from near silence, out under Sonata, one silent beat before the desktop reveal, out under the end card. */
const MUSIC_GAIN: Key[] = [
  [0, -42],
  [SECTIONS.anyApp.from, -9, "outSine"],
  [SECTIONS.anyApp.from + 0.8, -6, "inOutSine"],
  [SONATA_PLAY - 0.55, -6],
  [SONATA_PLAY - 0.05, -120, "inQuad"],
  [SECTIONS.moreApps.from - 0.06, -120],
  [SECTIONS.moreApps.from, -6],
  [SILENCE_AT - 0.06, -6],
  [SILENCE_AT, -120],
  [REVEAL_AT - 0.01, -120],
  [REVEAL_AT, -5],
  [SECTIONS.github.from + 0.6, -5],
  [SECTIONS.end.from + 0.5, -120, "inSine"],
];

export async function buildFilm(opts: {
  captions: boolean;
}): Promise<Composition> {
  const m = filmManifest();
  const ctx = { m };
  const scenes: Scene[] = [
    intro(ctx),
    integrated(ctx),
    moreApps(ctx),
    evolving(ctx),
    create(ctx),
    desktop(ctx),
    mac(ctx, macShrink()),
    iceberg(ctx),
    outro(ctx),
  ];
  const ready = await ensureDepViaCli(promoMusic, {
    stdio: "inherit",
    grant: null,
  });
  const music = downloadedFile(ready, PROMO_MUSIC.file);
  const cam = mergeCam(scenes);
  return {
    width: 1280,
    height: 720,
    duration: DURATION,
    background: SITE.bg,
    assets: { dir: ASSETS_DIR, manifest: m },
    camera: { ...cam, motionBlur: { cap: 3, gain: 0.04 } },
    layers: [
      ...scenes.flatMap((s) => s.underlay ?? []),
      ...scenes.flatMap((s) => s.layers),
    ],
    overlay: [
      ...scenes.flatMap((s) => s.overlay ?? []),
      ...(opts.captions ? captionLayers() : []),
    ],
    audio: {
      music: {
        file: music,
        sectionStart: PROMO_MUSIC.sectionStart,
        gainDb: MUSIC_GAIN,
      },
      clips: scenes.flatMap((s) => s.clips ?? []),
      sfx: scenes
        .flatMap((s) => s.sfx ?? [])
        .filter((c) => c.at >= 0 && c.at < DURATION)
        .sort((a, b) => a.at - b.at),
      sfxGainDb: -4,
    },
  };
}
