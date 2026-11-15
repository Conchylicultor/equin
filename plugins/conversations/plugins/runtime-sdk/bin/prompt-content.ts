import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { attachmentImagePathsOf } from "@plugins/conversations/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The model's image formats, told by their magic bytes (never the extension). */
function imageMediaTypeOf(bytes: Uint8Array): ImageMediaType | null {
  const at = (i: number, s: string) =>
    [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * A prompt as the agent hands it to Claude Code: the text unchanged, then
 * every attached image its `@<attachment disk path>` references name, as an
 * image block. The SDK does not expand `@` references the way the interactive
 * CLI did, so without the blocks the model's first act on every message with
 * a screenshot was a Read of it. The path stays in the text: it is what the
 * user wrote, and what the agent hands another agent to share the image.
 *
 * An image the model takes no block of (a format it does not read, a file
 * gone) stays a path only — the agent can still Read it. Claude Code scales
 * each block to the API's limits itself.
 */
export function promptContent(
  text: string,
  read: (path: string) => Uint8Array | null = readAttachedFile,
): SDKUserMessage["message"]["content"] {
  const images = attachmentImagePathsOf(text).flatMap((path) => {
    const bytes = read(path);
    const mediaType = bytes === null ? null : imageMediaTypeOf(bytes);
    return bytes === null || mediaType === null
      ? []
      : [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: mediaType,
              data: Buffer.from(bytes).toString("base64"),
            },
          },
        ];
  });
  return images.length === 0
    ? text
    : [{ type: "text" as const, text }, ...images];
}

/** An attached file's bytes, or null once it is gone (the orphan sweep took it). */
function readAttachedFile(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
