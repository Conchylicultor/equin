import { exposedColumns } from "@plugins/network/plugins/live/core";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { SongCoverAnswer } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { songTranscriptionShape } from "../../shared/shape";

// The run state every song row carries (`$columns.transcription`).
const transcription = exposedColumns(songTranscriptionShape.exposure);

/**
 * A transcribed song's cover while its score is not in: `pending` while the
 * agent transcribes, `failed` (the run's error) when it failed. Either wins
 * over the MusicXML source's art by the library's resolver rule, so a song
 * whose document does not exist yet never asks for its staff cover. A
 * finished transcription, and every song nobody transcribed, is not this
 * plugin's to answer for — the MusicXML source draws its cover.
 */
export function transcriptionCover(song: Song): SongCoverAnswer | undefined {
  const t = transcription.read(song);
  switch (t.status) {
    case "transcribing":
      return { kind: "pending", label: "Transcribing…" };
    case "failed":
      return { kind: "failed", message: t.error ?? "Transcription failed" };
    case "ready":
    case null:
      return undefined;
  }
}
