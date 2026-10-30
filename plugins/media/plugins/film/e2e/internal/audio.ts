// The film's sound, mixed by ffmpeg before the first frame renders: the music
// bed (seeked to its section, gain automated by a dB track), the placed audio
// clips, and the synthesized SFX bus (a WAV the page rendered).
//
// Only the MUSIC BED is loudness-normalized: its stem is measured on its own
// (gain automation included) and brought to the composition's target by one
// constant gain. Clips and SFX keep their own fixed levels — a mix can never
// amplify them, so a film with no music stays as quiet as its cues, and a cue's
// level relative to the bed is what the composition says. The sum is then only
// guarded by a true-peak limiter (it can lower a peak, never raise anything).
// The result is one 48 kHz stereo WAV spanning [from, to) that the encoder
// muxes as AAC.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Composition } from "./composition";
import { ease } from "./easing";
import type { Key, Track } from "./tracks";

/** Points of a dB track as a piecewise-linear curve (eased segments subdivided). */
function gainPoints(tr: Track, shift: number): Array<[number, number]> {
  if (!Array.isArray(tr)) return [[0, tr as number]];
  const keys = tr as readonly Key[];
  const pts: Array<[number, number]> = [];
  keys.forEach((k, i) => {
    const prev = keys[i - 1];
    const e = k[2];
    if (prev && e !== undefined && e !== "linear" && k[0] > prev[0]) {
      const N = e === "step" ? 1 : 16;
      for (let s = 1; s < N; s++) {
        const t = prev[0] + ((k[0] - prev[0]) * s) / N;
        pts.push([t + shift, prev[1] + (k[1] - prev[1]) * ease(e, s / N)]);
      }
      if (e === "step") pts.push([k[0] + shift - 1e-3, prev[1]]);
    }
    pts.push([k[0] + shift, k[1]]);
  });
  return pts;
}

const num = (n: number): string => (Math.round(n * 1e6) / 1e6).toString();

/** An ffmpeg expression of `t` for a piecewise-linear dB curve, as a balanced if-tree (bounded depth). */
export function gainExpr(pts: Array<[number, number]>): string {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) throw new Error("film: empty gain curve");
  const seg = (i: number): string => {
    const [ta, a] = pts[i] as [number, number];
    const [tb, b] = pts[i + 1] as [number, number];
    if (tb - ta < 1e-9 || a === b) return num(b);
    return `(${num(a)}+(${num(b - a)})*(t-${num(ta)})/${num(tb - ta)})`;
  };
  // Segments 0..n-2; tree over them.
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return seg(lo);
    const mid = Math.floor((lo + hi) / 2);
    const split = (pts[mid + 1] as [number, number])[0];
    return `if(lt(t,${num(split)}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  const db =
    pts.length === 1
      ? num(first[1])
      : `if(lt(t,${num(first[0])}),${num(first[1])},if(gte(t,${num(last[0])}),${num(last[1])},${tree(0, pts.length - 2)}))`;
  return `pow(10,(${db})/20)`;
}

async function run(argv: string[], what: string): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `film: ffmpeg ${what} exited ${code}:\n${stderr.slice(-4000)}`,
    );
  return stderr;
}

export interface MixInput {
  comp: Composition;
  from: number;
  to: number;
  /** The page-rendered SFX WAV spanning [from, to). */
  sfxWav: string;
  ffmpeg: string;
  work: string;
}

/** Integrated loudness of a file (LUFS), or null for silence. */
async function loudnessOf(
  ffmpeg: string,
  file: string,
): Promise<number | null> {
  const stderr = await run(
    [
      ffmpeg,
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "loudnorm=print_format=json",
      "-f",
      "null",
      "-",
    ],
    "loudness measure",
  );
  const m = JSON.parse(
    stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1),
  ) as Record<string, string>;
  const i = Number(m.input_i);
  return Number.isFinite(i) ? i : null;
}

const STEREO =
  "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

export async function mixAudio({
  comp,
  from,
  to,
  sfxWav,
  ffmpeg,
  work,
}: MixInput): Promise<string> {
  const audio = comp.audio ?? {};
  const dur = to - from;
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  const filters: string[] = [];
  const labels: string[] = [];
  let input = 0;
  const report: Record<string, unknown> = {};

  const music = audio.music;
  if (music) {
    const seek = [
      "-ss",
      num(music.sectionStart + from),
      "-t",
      num(dur),
      "-i",
      music.file,
    ];
    const automation = `${STEREO},asetnsamples=n=64,volume='${gainExpr(gainPoints(music.gainDb ?? 0, -from))}':eval=frame`;
    // The bed alone, automated, measured: its normalizing gain is one constant.
    const stem = join(work, "music-stem.wav");
    await run(
      [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        ...seek,
        "-af",
        automation,
        "-c:a",
        "pcm_f32le",
        stem,
      ],
      "music stem",
    );
    const target = audio.loudness ?? -16;
    const measured = await loudnessOf(ffmpeg, stem);
    const gainDb = measured === null ? 0 : target - measured;
    report.music = { measuredLufs: measured, targetLufs: target, gainDb };
    console.log(
      `audio: music bed ${measured === null ? "silent" : `${num(measured)} LUFS`} → ${target} LUFS (${num(gainDb)} dB)`,
    );
    args.push(...seek);
    filters.push(`[${input}:a]${automation},volume=${num(gainDb)}dB[m]`);
    labels.push("[m]");
    input++;
  }
  for (const clip of audio.clips ?? []) {
    const ac = comp.assets.manifest.audio[clip.audio];
    if (!ac)
      throw new Error(`film: the manifest has no audio clip "${clip.audio}"`);
    let offset = clip.offset ?? 0;
    let at = clip.at - from;
    let len = clip.duration ?? ac.duration - offset;
    if (at < 0) {
      offset -= at;
      len += at;
      at = 0;
    }
    len = Math.min(len, dur - at);
    if (len <= 0) continue;
    args.push("-i", join(comp.assets.dir, ac.file));
    const fi = clip.fadeIn ?? 0.01;
    const fo = clip.fadeOut ?? 0.05;
    const label = `[c${input}]`;
    filters.push(
      `[${input}:a]${STEREO},atrim=start=${num(offset)}:duration=${num(len)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${num(fi)},afade=t=out:st=${num(Math.max(0, len - fo))}:d=${num(fo)},` +
        `volume=${num(clip.gainDb ?? 0)}dB,adelay=${Math.round(at * 1000)}:all=1${label}`,
    );
    labels.push(label);
    input++;
  }

  args.push("-i", sfxWav);
  filters.push(
    `[${input}:a]${STEREO},volume=${num(audio.sfxGainDb ?? -3)}dB[s]`,
  );
  labels.push("[s]");
  input++;

  const mixed =
    labels.length === 1
      ? `${labels[0]}anull`
      : `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0`;
  // A peak guard only: attenuates what would clip, never adds gain.
  filters.push(
    `${mixed},alimiter=limit=0.841:level=false:attack=2:release=60,apad=whole_dur=${num(dur)},atrim=0:${num(dur)}[a]`,
  );
  const finalPath = join(work, "audio.wav");
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    finalPath,
  );
  await run([ffmpeg, ...args], "mix");
  report.mixLufs = await loudnessOf(ffmpeg, finalPath);
  writeFileSync(join(work, "loudness.json"), JSON.stringify(report, null, 2));
  console.log(
    `audio: mix ${report.mixLufs === null ? "silent" : `${num(report.mixLufs as number)} LUFS`} (SFX and clips at their own levels)`,
  );
  return finalPath;
}
