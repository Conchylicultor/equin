// A film's sound, kept beside it: `<film>.sound/` holds `sound.json` (the
// range the film was rendered over and its whole FilmAudio — music bed, placed
// clips, every SFX cue, levels) and a copy of each clip's audio file. That is
// everything the soundtrack is mixed from, and nothing of the picture, so the
// soundtrack can be made again — with another music bed — without the
// recordings or a single frame (remix.ts).
//
// The music bed's file is referenced, not copied: a remix replaces it.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { AudioClip } from "./assets";
import type { Composition, FilmAudio } from "./composition";

/** What `sound.json` holds. */
export interface FilmSound {
  version: 1;
  /** The film time range the film was rendered over: its t=0 is `from`. */
  from: number;
  to: number;
  audio: FilmAudio;
  /** Every clip `audio.clips` places, by manifest name; `file` is relative to the sound dir. */
  clips: Record<string, AudioClip>;
}

const SOUND_FILE = "sound.json";

/** `<name>.sound` beside `<name>.mp4`: the film's sound dir. */
export function soundDirOf(film: string): string {
  return film.replace(/(\.[a-z0-9]+)?$/i, () => ".sound");
}

/**
 * Write `comp`'s sound for a film rendered over [from, to) into `dir`, which
 * must not exist yet (a film is a version; its sound is part of it).
 */
export function writeFilmSound(
  dir: string,
  comp: Composition,
  from: number,
  to: number,
): void {
  if (existsSync(dir))
    throw new Error(
      `film: ${dir} already exists — a film's sound is never written over`,
    );
  const audio = comp.audio ?? {};
  mkdirSync(join(dir, "clips"), { recursive: true });
  const clips: Record<string, AudioClip> = {};
  for (const { audio: name } of audio.clips ?? []) {
    if (name in clips) continue;
    const ac = compClip(comp)(name);
    const file = join("clips", `${name}-${basename(ac.file)}`);
    copyFileSync(ac.file, join(dir, file));
    clips[name] = { file, duration: ac.duration };
  }
  writeSoundFile(dir, { version: 1, from, to, audio, clips });
}

/** (Re)write `dir`'s `sound.json`: a remix's copy of its film's sound dir, under its new bed. */
export function writeSoundFile(dir: string, sound: FilmSound): void {
  writeFileSync(join(dir, SOUND_FILE), `${JSON.stringify(sound, null, 2)}\n`);
}

// The cues, clips and tracks are the engine's own types, written by
// writeFilmSound; the envelope is what a reader must be able to rely on.
const SoundEnvelope = z.object({
  version: z.literal(1),
  from: z.number(),
  to: z.number(),
  audio: z.record(z.string(), z.unknown()),
  clips: z.record(
    z.string(),
    z.object({ file: z.string(), duration: z.number() }),
  ),
});

/** The sound of `film` (its `<name>.sound/`), or a loud error naming what is missing. */
export function readFilmSound(film: string): { dir: string; sound: FilmSound } {
  const dir = soundDirOf(film);
  const path = join(dir, SOUND_FILE);
  if (!existsSync(path))
    throw new Error(
      `film: ${film} has no sound beside it (${path}) — only a film rendered since the engine kept its sound can be remixed`,
    );
  const parsed = SoundEnvelope.parse(JSON.parse(readFileSync(path, "utf8")));
  return { dir, sound: parsed as unknown as FilmSound };
}

/** A composition's clip lookup: manifest name → absolute file and length. */
export function compClip(comp: Composition): (name: string) => AudioClip {
  return (name) => {
    const ac = comp.assets.manifest.audio[name];
    if (!ac) throw new Error(`film: the manifest has no audio clip "${name}"`);
    return { file: join(comp.assets.dir, ac.file), duration: ac.duration };
  };
}

/** A sound dir's clip lookup: manifest name → its copy's absolute file and length. */
export function soundClip(
  dir: string,
  sound: FilmSound,
): (name: string) => AudioClip {
  return (name) => {
    const ac = sound.clips[name];
    if (!ac) throw new Error(`film: ${dir} has no audio clip "${name}"`);
    return { file: join(dir, ac.file), duration: ac.duration };
  };
}
