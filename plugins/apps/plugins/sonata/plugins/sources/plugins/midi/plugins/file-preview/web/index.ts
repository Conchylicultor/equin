import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FileViewer } from "@plugins/primitives/plugins/file-viewer/web";
import { MidiFilePreview } from "./components/midi-file-preview";
import { supportsMidi } from "./supports";

export default {
  description:
    "Sonata's MIDI file preview: a FileViewer renderer (native for .mid/.midi files, host or workspace) showing the file in Sonata's mini player (the falling notes, the progression capsule over them), with Open in Sonata — imported into the library idempotently by content, at the playhead's bar — as the host header's Expand.",
  contributions: [
    FileViewer.Renderer({
      id: "sonata-midi",
      label: "MIDI",
      supports: ({ file }) => supportsMidi(file),
      component: MidiFilePreview,
    }),
  ],
} satisfies PluginDefinition;
