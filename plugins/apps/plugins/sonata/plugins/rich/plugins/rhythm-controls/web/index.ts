import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  grooveSetting,
  SonataDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { groovePresetsConfig } from "../shared/groove-presets";
import { RhythmObserver } from "./components/rhythm-observer";

export { RhythmControls } from "./components/rhythm-controls";
export { GrooveSwitch } from "./components/groove-switch";

export { useSaveRhythm } from "./actions";
export type { RhythmGroove } from "./actions";
export { useGroove } from "./use-groove";
export type { Groove, GrooveState } from "./use-groove";
export { useGroovePresets } from "./use-groove-presets";
export type { GroovePresetsController } from "./use-groove-presets";
export { grooveEquals, grooveSummary, presetGroove } from "../shared/groove";
export type { GrooveContent, GrooveFields } from "../shared/groove";
export type { GroovePreset } from "../shared/groove-presets";

export default {
  description:
    "Sonata accompaniment part: the per-song groove. Exports its on/off switch (GrooveSwitch) and its body (RhythmControls: a groove preset picker, a left-hand (bass) and right-hand (chords) onset necklace that spins with the playhead, and one expanded block per hand: on/off chip in its track's colour, pattern, rhythm, octave, voice-leading, rotate, steps, octave doubling) for the Accompaniment section to compose; contributes no section of its own. Persists the groove per song and feeds the song document's score pipeline as a per-song setting (SonataDocument.SongSetting) settled by a headless observer. Owns the global groove presets (config sonata groove-presets: useGroovePresets) and the per-song preset provenance useGroove carries.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: groovePresetsConfig }),
    SonataDocument.SongSetting({
      id: "rhythm-sync",
      setting: grooveSetting,
      component: RhythmObserver,
    }),
  ],
} satisfies PluginDefinition;
