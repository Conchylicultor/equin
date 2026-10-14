import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { sonataPlayerPane } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { AudioEngine } from "./components/audio-engine";
import { AudioProvider } from "./components/audio-provider";
import { VolumeControl } from "./components/volume-control";

// Shared audio toolkit for sibling per-surface audio effects (the metronome):
// the live graph handle and the timeline-following look-ahead scheduler.
// Reusing `startScheduling` gives clicks the same seamless A–B loop wrap,
// tempo re-timing and driver following as note playback, for free.
export { useAudioGraph, type AudioGraph } from "./audio-store";
export { startScheduling, type ScheduleHandle } from "./scheduler";

export default {
  description:
    "Sonata audio engine: schedules the Score's notes against the Web Audio clock on play, routing each note to its track's resolved instrument, with master volume in the player pane's header.",
  contributions: [
    // Per-session audio store, folded above the whole session subtree so the
    // engine effect and the volume control (different slot branches) share one
    // store — and two sessions stay independent.
    SonataSession.Provider({ id: "audio", component: AudioProvider }),
    // The Web Audio graph lives in a headless, always-mounted effect so the
    // AudioContext survives the player's section column being collapsed.
    SonataSession.Effect({ id: "audio-engine", component: AudioEngine }),
    // The master-volume slider, pinned into the player pane's header; owns no
    // audio.
    sonataPlayerPane.Actions({ id: "volume", component: VolumeControl }),
  ],
} satisfies PluginDefinition;
