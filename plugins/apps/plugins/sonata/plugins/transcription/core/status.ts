/** Where a song's transcription stands. */
export const TRANSCRIPTION_STATUSES = [
  "transcribing",
  "ready",
  "failed",
] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];
