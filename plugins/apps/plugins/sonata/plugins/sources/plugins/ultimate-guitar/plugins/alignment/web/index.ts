import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  RecordingSwitch,
  SonataRecording,
} from "@plugins/apps/plugins/sonata/plugins/recording/web";
import { UgAlignmentSync } from "./components/alignment-sync";
import { UgRecordingVideo } from "./components/recording-video-claim";
import { ReportVideoRefused } from "./components/report-video-refused";
import { useUgLibrarySong } from "./internal/use-ug-raw";
import { RecordingSection } from "./components/recording-section";
import { ugVideoPresentation } from "./internal/presentation";

export default {
  description:
    "UG sheet alignment in the player: a 'Recording' editor section showing the song's YouTube video (the recording plugin's RecordingVideo viewport with its volume, and its on/off RecordingSwitch in the header; the video itself is declared by a headless effect to the session's recording player, so it keeps playing — synced to the transport when the song plays on its alignment, a weak match included, else on its own — while the section is collapsed), an alignment status box (icon, status line, one control — Cancel, Re-align, Retry, Try another or Find a video — and while working a three-stage bar: find a video, analyse the audio, align the sheet), the video's line (title, match chip, channel, Replace) and an inline picker (a YouTube link, the candidate videos with thumbnail and outcome — click one to switch — and Search again); a headless report of a video the player refuses (SonataRecording.Refused → video-refused), and a headless effect writing the applied alignment record into the Ultimate Guitar raw so the Score plays on the recording's beats. In the library: the Video field's presentation (hidden by default).",
  contributions: [
    Sonata.Section({
      id: "ug-alignment-recording",
      label: "Recording",
      icon: symbol("smart-display"),
      component: RecordingSection,
      // The video on/off switch, reachable while the section is collapsed.
      actions: RecordingSwitch,
      area: "editor",
      useAvailable: () => useUgLibrarySong() !== null,
      // Open by default when the song plays on a video (it holds the video);
      // only seeds the persisted toggle, read once per mount.
      useDefaultOpen: () =>
        (useUgLibrarySong()?.raw.alignment ?? null) !== null,
    }),
    Sonata.Effect({ id: "ug-alignment-sync", component: UgAlignmentSync }),
    // Declares the song's recording to the session's player, so the video
    // plays (and drives the transport) whether the section is open or not.
    Sonata.Effect({ id: "ug-recording-video", component: UgRecordingVideo }),
    // The player refused the video: mark the candidate, and re-pick if ours.
    SonataRecording.Refused({
      id: "ug-video-refused",
      component: ReportVideoRefused,
    }),
    // The UG song's cover in the library (its video's thumbnail, else the
    // chord sheet) — here, not in the UG source: the video is this plugin's.
    ugVideoPresentation,
  ],
} satisfies PluginDefinition;
