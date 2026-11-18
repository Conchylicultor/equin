// A remix: a finished film under another soundtrack, made from the sound kept
// beside it (sound.ts) — the same SFX synth and mix as its render
// (soundtrack.ts), the music bed swapped by the caller — and muxed over the
// film's own video, copied bit for bit (no frame is rendered). Its web
// version, when the film has one, is the web version's video under the same
// soundtrack. Like a render, a remix is a new version: it never writes over a
// file, and keeps its own sound beside it (so a remix can be remixed).

import { cpSync, existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveFfmpeg } from "@plugins/media/plugins/ffmpeg/deps";
import {
  flag,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { FilmAudio, MusicBed } from "./composition";
import { remuxArgs, runFfmpeg } from "./encode";
import { webVersionOf } from "./run";
import { filmServer, STAGE_URL } from "./serve";
import {
  readFilmSound,
  soundClip,
  soundDirOf,
  writeSoundFile,
  type FilmSound,
} from "./sound";
import { makeSoundtrack, soundSamples } from "./soundtrack";

export interface RemixOptions {
  /** The finished film (`<name>.mp4`, its sound at `<name>.sound/`). */
  film: string;
  /** The remix (`.mp4`); its web version and sound are written beside it. */
  out: string;
  /** The remix's music bed, from the film's own (`undefined`: the film had none). */
  music(film: MusicBed | undefined): MusicBed;
}

export async function remixFilm(o: RemixOptions): Promise<void> {
  // The harness films every run unless told not to; a remix renders no page worth filming.
  if (!flag("no-record")) process.argv.push("--no-record");
  if (!existsSync(o.film)) usage(`film: no film at ${o.film}`);
  const { dir, sound } = readFilmSound(o.film);
  const filmWeb = webVersionOf(o.film);
  const outWeb = existsSync(filmWeb) ? webVersionOf(o.out) : null;
  const outSound = soundDirOf(o.out);
  for (const p of [o.out, outWeb, outSound])
    if (p !== null && existsSync(p))
      usage(`film: ${p} already exists — a remix never writes over a film.`);

  const audio: FilmAudio = {
    ...sound.audio,
    music: o.music(sound.audio.music),
  };
  const remixed: FilmSound = { ...sound, audio };
  const duration = sound.to - sound.from;
  const work = join(tmpdir(), "film", `remix-${basename(o.out)}`);
  mkdirSync(work, { recursive: true });
  const ff = await resolveFfmpeg();

  const mixed = await withBrowser(async (h) => {
    const server = await filmServer(null, await soundSamples(audio));
    const { page } = await h.session({ capture: false });
    await server.serve(page);
    await page.goto(STAGE_URL, { waitUntil: "load" });
    return makeSoundtrack({
      page,
      audio,
      clip: soundClip(dir, sound),
      from: sound.from,
      to: sound.to,
      ffmpeg: ff.ffmpeg,
      work,
    });
  });

  const outs: Array<[video: string, out: string, web: boolean]> = [
    [o.film, o.out, false],
    ...(outWeb ? [[filmWeb, outWeb, true] as [string, string, boolean]] : []),
  ];
  for (const [video, out, web] of outs) {
    const partial = join(
      dirname(out),
      `.${basename(out)}.partial-${process.pid}.mp4`,
    );
    try {
      await runFfmpeg(
        ff.ffmpeg,
        remuxArgs({ video, audio: mixed, duration, out: partial, web }),
        `remixing ${video} into ${partial}`,
      );
      linkSync(partial, out);
    } finally {
      rmSync(partial, { force: true });
    }
    console.log(`wrote ${out}`);
  }
  // The remix's sound: the film's clips, under the new bed.
  cpSync(dir, outSound, { recursive: true, errorOnExist: true, force: false });
  writeSoundFile(outSound, remixed);
  console.log(`wrote ${outSound}`);
}
