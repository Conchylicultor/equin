import { z } from "zod";
import { defineThreadResult } from "@plugins/conversations/plugins/agent-thread/core";

/** The MCP tool the transcribing agent submits its score with. */
export const SUBMIT_TOOL = "sonata_submit_transcription";

/** What the agent submits: the MusicXML file in its workspace. */
export const SubmitTranscriptionSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'The MusicXML file, relative to your working directory (e.g. "score.musicxml").',
    ),
});
export type SubmitTranscription = z.infer<typeof SubmitTranscriptionSchema>;

/**
 * The result kind of a transcription thread: one accepted submit is one score
 * in the song (a correction turn submits again and replaces it). The server's
 * tool takes the same schema as its input, so the thread parses exactly what
 * the tool accepted.
 */
export const transcriptionScore = defineThreadResult({
  tool: SUBMIT_TOOL,
  schema: SubmitTranscriptionSchema,
});
