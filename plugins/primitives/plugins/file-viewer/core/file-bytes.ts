import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { FileRef } from "./file-ref";

/** A {@link FileRef} as a question: where the file's bytes live. */
const FileRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("host"), path: z.string() }),
  z.object({
    source: z.literal("workspace"),
    workspace: z.string(),
    ref: z.string().optional(),
    path: z.string(),
  }),
]) satisfies ZodParser<FileRef>;

/** The largest file whose bytes are handed over whole (64 MiB). */
export const FILE_BYTES_MAX = 64 * 1024 * 1024;

/**
 * A file's raw bytes, whichever source holds it — for a renderer that decodes
 * the format itself (a MIDI file, an archive listing): `useLive(fileBytes,
 * file)` → `ResourceResult<ArrayBuffer>`. A `bytes` value: read on demand over
 * HTTP as `application/octet-stream`, re-read after the server invalidates it
 * — a host file from a watch of its folder while it is read.
 *
 * Refused (each a determinate answer about the file, never retried):
 * - `missing` / `denied` — not there, or not readable by the user account;
 * - `too-large` — over {@link FILE_BYTES_MAX};
 * - `unsupported` — the source does not serve these bytes (a folder, an
 *   unreadable archive member, a workspace file: see the plugin's CLAUDE.md);
 * - `invalid-path` — a host path neither absolute nor `~`-rooted, or with a NUL.
 */
export const fileBytes = liveValue("file-viewer.bytes", {
  bytes: true,
  query: FileRefSchema,
  maxBytes: FILE_BYTES_MAX,
  refusals: ["missing", "denied", "unsupported", "invalid-path"],
  needsMachine: { feature: "Reading files on this computer" },
});
