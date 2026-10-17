import { z } from "zod";

/**
 * Where a transcription's score comes from — what the user asked for, stored on
 * the song so a retry relaunches the same thing.
 *
 * `prompt` is what the Transcribe launch form sends: the user's own words (a
 * link, instructions, pasted page images and PDFs inline as attachment refs),
 * plus the attachment ids found in them. `url` / `files` are the earlier
 * dialog's structured inputs, kept so rows written by it still decode and
 * retry.
 */
export const TranscriptionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    prompt: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)),
  }),
  z.object({ kind: z.literal("url"), url: z.string().url() }),
  z.object({
    kind: z.literal("files"),
    attachmentIds: z.array(z.string().min(1)).min(1),
  }),
]);
export type TranscriptionInput = z.infer<typeof TranscriptionInputSchema>;
