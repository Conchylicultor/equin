import { z } from "zod";

/**
 * Where a transcription's score comes from: a video or post link (anything
 * yt-dlp reads — Instagram, YouTube, …) or uploaded files (images, PDF), as
 * attachment ids. What the user asked for, stored on the song so a retry
 * relaunches the same thing.
 */
export const TranscriptionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url() }),
  z.object({
    kind: z.literal("files"),
    attachmentIds: z.array(z.string().min(1)).min(1),
  }),
]);
export type TranscriptionInput = z.infer<typeof TranscriptionInputSchema>;
