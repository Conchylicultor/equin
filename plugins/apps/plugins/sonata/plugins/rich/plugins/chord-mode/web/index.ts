import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  chordModeSetting,
  SonataDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { ChordModeObserver } from "./components/chord-mode-observer";

export { useSaveChordMode } from "./actions";
export { ChordModeSwitch } from "./components/chord-mode-switch";
export { useChordModeAvailable } from "./use-available";

export default {
  description:
    "Sonata accompaniment part: per-song chord mode. Exports the Accompaniment on/off switch of a song with notes of its own and chords, detected or authored (ChordModeSwitch) and its gate (useChordModeAvailable) for the Accompaniment section's header: on, the song document voices the song's chords (detected and authored) onto the Chords / Bass tracks (through the same groove as a chord grid) and the original tracks are turned off in the Tracks card, where any of them can be re-enabled. Persists per song and registers with the song document's score pipeline as a per-song setting (SonataDocument.SongSetting) settled by a headless observer.",
  contributions: [
    SonataDocument.SongSetting({
      id: "chord-mode-sync",
      setting: chordModeSetting,
      component: ChordModeObserver,
    }),
  ],
} satisfies PluginDefinition;
