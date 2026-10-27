import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Prepare a transcription from the launch form's text: creates the song
 * (MusicXML source, a placeholder title), its transcription row and a Sonata
 * task already set to run in the `sonata.transcription` scratch workspace.
 * Launches nothing: the caller launches `taskId` with `prompt` through the
 * standard task launch (`POST /api/tasks/launch`), carrying the user's launch
 * options. The song shows as transcribing until the agent submits its score.
 */
export const prepareTranscription = defineEndpoint({
  route: "POST /api/sonata/transcription/prepare",
  body: z.object({ text: z.string().min(1) }),
  response: z.object({
    song: z.object({ id: z.string(), title: z.string() }),
    taskId: z.string(),
    prompt: z.string(),
  }),
});

/** Relaunch a failed transcription on the same song, from the same input. */
export const retryTranscription = defineEndpoint({
  route: "POST /api/sonata/songs/:id/transcription/retry",
  response: z.object({ conversationId: z.string() }),
});
