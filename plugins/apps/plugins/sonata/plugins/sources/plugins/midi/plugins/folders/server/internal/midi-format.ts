import { corpusFormat } from "@plugins/infra/plugins/corpus-index/core";

// A `.mid` / `.midi` file, any case (the extension of the path's last segment).
const MIDI_FILE = /\.midi?$/i;

// Which files the watched-folder index holds: every MIDI file, no per-file
// payload (enumerate-only). Its own module so the index is stamped with this
// code alone — a change to which files count rebuilds the index, and nothing
// else in the plugin does.
export const midiFileFormat = corpusFormat(import.meta, {
  match: (p: string) => MIDI_FILE.test(p),
});
