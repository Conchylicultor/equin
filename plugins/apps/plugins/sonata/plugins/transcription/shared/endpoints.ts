import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TRANSCRIPTION_STATUSES } from "../core";
import { TranscriptionInputSchema } from "./input";

/**
 * Start transcribing: creates the song (MusicXML source, a placeholder title),
 * its transcription row and a Sonata task, and launches the transcribing
 * agent in a scratch workspace. Answers the song so the caller opens it at
 * once — it shows as transcribing until the agent submits its score.
 */
export const transcribeSong = defineEndpoint({
  route: "POST /api/sonata/transcribe",
  body: z.object({ input: TranscriptionInputSchema }),
  response: z.object({ id: z.string(), title: z.string() }),
});

/** Relaunch a failed transcription on the same song, from the same input. */
export const retryTranscription = defineEndpoint({
  route: "POST /api/sonata/songs/:id/transcription/retry",
  response: z.object({ conversationId: z.string() }),
});

/**
 * One song's transcription state, or `null` for a song nobody transcribed —
 * the source's `hydrate`, a one-shot read outside React.
 */
export const getSongTranscription = defineEndpoint({
  route: "GET /api/sonata/songs/:id/transcription",
  response: z
    .object({
      status: z.enum(TRANSCRIPTION_STATUSES),
      error: z.string().nullable(),
    })
    .nullable(),
});
