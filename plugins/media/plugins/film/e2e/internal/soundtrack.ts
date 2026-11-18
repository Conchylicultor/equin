// A film's soundtrack, made one way for a render and a remix: the SFX bus
// synthesized in a film page from the cues of [from, to), then the mix
// (audio.ts) of the music bed, the placed clips and that bus.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { resolveMouseSounds } from "../../deps";
import type { AudioClip } from "./assets";
import { mixAudio } from "./audio";
import type { FilmAudio } from "./composition";
import { cuesInRange } from "./cues";
import type { FilmWindowApi } from "./page/main";

/** The recorded sounds the SFX synth plays for `audio` (filmServer's `samples`): the mouse, only for a film that clicks. */
export async function soundSamples(
  audio: FilmAudio | undefined,
): Promise<Record<string, string>> {
  if (!(audio?.sfx ?? []).some((c) => c.kind === "click")) return {};
  const mouse = await resolveMouseSounds();
  return {
    "mouse-press.wav": mouse.press,
    "mouse-release.wav": mouse.release,
  };
}

/** The mixed soundtrack of [from, to) as a WAV in `work` (its path). */
export async function makeSoundtrack(o: {
  /** A film page served with `soundSamples(audio)`. */
  page: Page;
  audio: FilmAudio;
  clip(name: string): AudioClip;
  from: number;
  to: number;
  ffmpeg: string;
  work: string;
}): Promise<string> {
  const cues = cuesInRange(o.audio.sfx ?? [], o.from, o.to);
  const wav = await o.page.evaluate(
    ([c, d]) =>
      (window as unknown as { __film: FilmWindowApi }).__film.renderSfx(c, d),
    [cues, o.to - o.from] as const,
  );
  const sfxWav = join(o.work, "sfx.wav");
  writeFileSync(sfxWav, Buffer.from(wav, "base64"));
  console.log(`sfx: ${cues.length} cues → ${sfxWav}`);
  return mixAudio({
    audio: o.audio,
    clip: o.clip,
    from: o.from,
    to: o.to,
    sfxWav,
    ffmpeg: o.ffmpeg,
    work: o.work,
  });
}
