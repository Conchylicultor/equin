import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Library } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { MidiLoader } from "./loader";
import { parseMidi } from "../shared/parse";
import { MIDI_SOURCE_ID } from "./constants";
import { hydrate } from "./hydrate";
import { midiCreateOption } from "./components/midi-create-option";
import { midiPresentation } from "./internal/presentation";
import { midiCover } from "./internal/cover";
import { symbol } from "@plugins/ui/plugins/icons/core";

// Re-export the source id so consumers can identify this source without
// depending on its internal layout.
export { MIDI_SOURCE_ID };
export { importMidiBytes, type ImportedMidiSong } from "./import-midi";
export { deriveMidiSongMeta, type MidiSongMeta } from "../shared/parse";

export default {
  description:
    "MIDI file input source for Sonata. Dropzone accepts .mid/.midi files; compile() parses them into a Score via @tonejs/midi. Persists per-song MIDI (attachment + track count) and contributes the library Import affordance, hydration, the song's falling-notes cover, and the cell of the Tracks field its extension exposes on every list of songs.",
  contributions: [
    SonataDocument.Source({
      id: MIDI_SOURCE_ID,
      label: "MIDI File",
      icon: symbol("music-note"),
      LoaderComponent: MidiLoader,
      compile: parseMidi,
    }),
    Library.Source({
      sourceId: MIDI_SOURCE_ID,
      hydrate,
      createOption: midiCreateOption,
    }),
    Library.Cover({ id: MIDI_SOURCE_ID, cover: midiCover }),
    midiPresentation,
  ],
} satisfies PluginDefinition;
