import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { songTranscriptionShape } from "../../shared/shape";

/**
 * The transcription fields of every list of songs, from the transcription
 * exposure (`songTranscriptionShape`): a song still being transcribed, or
 * whose transcription failed, is badged on its card through the status
 * options — "Transcribing" is a filter, run on the server. A transcribed song
 * and every other song draw nothing (their options are quiet). The latest
 * conversation and error are what the player's pending body reads; a list
 * leaves them out by default.
 */
export const transcriptionPresentation = FieldPresentation.Register({
  owner: songTranscriptionShape.exposure,
  fields: {
    conversationId: { visible: false },
    error: { visible: false },
  },
});
