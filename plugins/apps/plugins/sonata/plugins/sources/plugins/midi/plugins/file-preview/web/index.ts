import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FileViewer } from "@plugins/primitives/plugins/file-viewer/web";
import { MidiFilePreview } from "./components/midi-file-preview";
import { supportsMidi } from "./supports";

export default {
  description:
    "Sonata's MIDI file preview: a FileViewer renderer (native for .mid/.midi files, host or workspace) showing the file's facts (duration, tempo, meter, bars, tracks and notes, range, size), Sonata's falling-notes piano roll in its own player with a play bar, and Open in Sonata — imported into the library idempotently by content — at the playhead's bar.",
  contributions: [
    FileViewer.Renderer({
      id: "sonata-midi",
      label: "MIDI",
      supports: ({ file }) => supportsMidi(file),
      component: MidiFilePreview,
    }),
  ],
} satisfies PluginDefinition;
