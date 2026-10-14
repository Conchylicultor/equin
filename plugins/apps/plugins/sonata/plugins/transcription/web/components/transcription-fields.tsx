import type {
  FieldDef,
  FieldExtensionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { transcriptionColumns } from "../../core";

/**
 * Field extension contributed into the library's `Library.Fields` factory: a
 * song still being transcribed, or whose transcription failed, is badged on
 * its card — and "Transcribing" is a filter, run on the server over the
 * `transcription` columns. A transcribed song that is ready, and every other
 * song, renders nothing.
 */
const TRANSCRIPTION_FIELDS: FieldDef<Song>[] = [
  {
    id: "transcription",
    label: "Transcription",
    type: "enum",
    options: [
      { value: "transcribing", label: "Transcribing" },
      { value: "failed", label: "Failed" },
      { value: "ready", label: "Transcribed" },
    ],
    value: (s) => transcriptionColumns.read(s).status,
    cell: (s) => {
      switch (transcriptionColumns.read(s).status) {
        case "transcribing":
          return <Badge variant="info">Transcribing</Badge>;
        case "failed":
          return <Badge variant="destructive">Transcription failed</Badge>;
        case "ready":
        case null:
          return null;
      }
    },
    column: transcriptionColumns.column("status"),
  },
];

export function TranscriptionFields({ render }: FieldExtensionProps<Song>) {
  return <>{render(TRANSCRIPTION_FIELDS)}</>;
}
