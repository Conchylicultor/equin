import { basename } from "node:path";
import { z } from "zod";

/** The `sonata.transcription` scratch profile's id. */
export const TRANSCRIPTION_PROFILE_ID = "sonata.transcription";

/** The MCP tool the transcribing agent submits its score with. */
export const SUBMIT_TOOL = "sonata_submit_transcription";

/**
 * What the profile is launched with (the workspace spec's `input`): the song
 * the score goes to, and the source as the agent's directory holds it — a link
 * it fetches itself, or uploaded files (copied into `input/` by `prepare`).
 */
export const ProfileInputSchema = z.object({
  songId: z.string().min(1),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("url"), url: z.string().url() }),
    z.object({
      kind: z.literal("files"),
      files: z
        .array(z.object({ attachmentId: z.string().min(1), name: z.string() }))
        .min(1),
    }),
  ]),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

/**
 * Where the `index`th (0-based) uploaded file lands, relative to the agent's
 * directory: `input/NN-<name>`, numbered so the order the user gave is the
 * order the agent reads, and named after the upload with every path separator
 * and anything outside a conservative set replaced — the name comes from the
 * user's machine and must never leave `input/`.
 */
export function inputFilePath(index: number, name: string): string {
  const safe = basename(name.replaceAll("\\", "/"))
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const n = String(index + 1).padStart(2, "0");
  return `input/${n}-${safe.length > 0 ? safe : "file"}`;
}
