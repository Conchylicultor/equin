import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { SonataSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { recordingConfig, recordingVideoConfig } from "../shared/config";
import { RecordingProvider } from "./internal/recording-store";
import { SonataRecording } from "./slots";

export { SonataRecording } from "./slots";
export { useMediaRefusal, type MediaRefusal } from "./refusal";
// Whoever shows a song's recording (the UG alignment) declares it with
// `useShowRecording` from an always-mounted effect, renders the viewport
// (`RecordingVideo`) where it shows it, and the on/off switch
// (`RecordingSwitch`) in that place's header. The player itself is the
// session's.
export { useShowRecording } from "./internal/recording-store";
export { RecordingVideo, RecordingSwitch } from "./components/recording-video";

export default {
  description:
    "Sonata recording: the session's recording player — the YouTube video whoever shows a song's recording declares (useShowRecording), owned by the playback session so it outlives what shows it: RecordingVideo is only a viewport the playing iframe is moved into (Element.moveBefore, never reloaded) and out of, to an off-screen parking spot, so collapsing its section or switching the display neither stops nor reloads it. When the open score is timed on that video (Score.meta.recording) it is the session's transport driver while ready — the cursor, the synth and the A–B loop follow the video, its rate is the tempo; otherwise it plays on its own with YouTube's controls under a “Not synced” badge. RecordingSwitch turns the video off (the synth plays alone, same timing) and on. The video's on/off persists in the sonata.recording-video config; its sound, level and the sync offset (no control in the card; Settings → Config) in the sonata.recording config. Owns the SonataRecording.Refused seam for whoever picked a video YouTube refuses to embed.",
  slots: { ...SonataRecording },
  contributions: [
    ConfigV2.WebRegister({ descriptor: recordingConfig }),
    ConfigV2.WebRegister({ descriptor: recordingVideoConfig }),
    SonataSession.Provider({ id: "recording", component: RecordingProvider }),
  ],
} satisfies PluginDefinition;
