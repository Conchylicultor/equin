import type { SourceHydration } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { getSongTranscription } from "../shared/endpoints";
import { TranscriptionBody } from "./components/transcription-body";

/**
 * A transcribed song is `pending` until its score is in: the player shows
 * {@link TranscriptionBody} (the live run state) instead of an empty score.
 * Once ready — or for a song nobody transcribed — this source has nothing to
 * add (`absent`): the score is the MusicXML source's.
 */
export async function hydrate(songId: string): Promise<SourceHydration> {
  const row = await fetchEndpoint(getSongTranscription, { id: songId });
  if (row === null) return { kind: "absent" };
  switch (row.status) {
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
}
