import { exposedColumns } from "@plugins/network/plugins/live/core";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { songLibrary } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { SourceHydration } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { songTranscriptionShape } from "../shared/shape";
import { TranscriptionBody } from "./components/transcription-body";

// The run state every song row carries, folded in from the transcription
// exposure (`$columns.transcription`).
const transcription = exposedColumns(songTranscriptionShape.exposure);

/**
 * A transcribed song is `pending` until its score is in: the player shows
 * {@link TranscriptionBody} (the live run state) instead of an empty score.
 * Once ready — or for a song nobody transcribed — this source has nothing to
 * add (`absent`): the score is the MusicXML source's. Read live off the song's
 * row, so the player loads the score the moment the run turns ready.
 */
export function useHydration(songId: string): ResourceResult<SourceHydration> {
  return mapRow(useLiveRow(songLibrary, songId), (song): SourceHydration => {
    const status = song === null ? null : transcription.read(song).status;
    switch (status) {
      case null:
      case "ready":
        return { kind: "absent" };
      case "transcribing":
        return {
          kind: "pending",
          label: "Transcribing…",
          Body: TranscriptionBody,
        };
      case "failed":
        return {
          kind: "pending",
          label: "Transcription failed",
          Body: TranscriptionBody,
        };
    }
  });
}
