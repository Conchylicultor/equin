import { base64ImageSize } from "./image-key";

/** What an archived tool result holds where the agent's image was. */
export const ARCHIVED_IMAGE_TEXT = "[image left out of the backup]";

/** A chain file's JSONL in its archive form, and how many tool images it left out. */
export interface ArchivedTranscript {
  jsonl: string;
  imagesLeftOut: number;
}

/**
 * A session file's JSONL as a backup keeps it: every image a TOOL returned to
 * the agent (a screenshot it read, an MCP browser capture) left out — in the
 * tool result the model saw and in the line's `toolUseResult` copy of it —
 * and everything else byte-for-byte.
 *
 * Those images are most of a long agent transcript (97 MB of a 106 MB one) and
 * no surface shows them: the transcript reader drops them on the way in
 * (`dropUnreadPayloads`), and the screenshot artifact reads the picture's FILE.
 * So a restored transcript renders as the original did — each stripped result
 * keeps its first image's `image_size`, the reader's `ToolCallResult.imageSize`
 * — but for a note where each image was: a stripped image becomes a text block
 * saying so, never an empty result, so the transcript still resumes and neither
 * the model nor a reader takes the result for having held nothing. What
 * resuming loses is the model seeing those images again.
 *
 * Images the transcript DOES show are kept: a user message's own image blocks
 * and an attached file's image (`visitInlineImages`). The rest of
 * `toolUseResult` is kept too — rewind reads a background receipt from it and
 * the reader an AskUserQuestion answer — and it is small once its images are
 * gone. A line holding no image (most of them) is never parsed.
 */
export function archiveTranscriptJsonl(jsonl: string): ArchivedTranscript {
  let imagesLeftOut = 0;
  const lines = jsonl.split("\n").map((text) => {
    if (!text.includes('"image"')) return text;
    const line = parseLine(text);
    if (!line) return text;
    const stripped = stripToolImages(line);
    if (!stripped.changed) return text;
    imagesLeftOut += stripped.images;
    return JSON.stringify(line);
  });
  return { jsonl: lines.join("\n"), imagesLeftOut };
}

function parseLine(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (err) {
    // A torn final line (the CLI was mid-append) is archived as it is.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

interface ImagePart {
  type?: unknown;
  source?: { type?: unknown; data?: unknown };
  file?: { base64?: unknown };
}

/**
 * Strip a line's tool images in place. `images` counts the tool results' own
 * images only — `toolUseResult` holds copies of them.
 */
function stripToolImages(line: Record<string, unknown>): {
  changed: boolean;
  images: number;
} {
  let images = 0;
  let changed = false;
  const message = line.message as { content?: unknown } | undefined;
  if (Array.isArray(message?.content)) {
    for (const block of message.content as ({
      type?: unknown;
      content?: unknown;
      image_size?: unknown;
    } | null)[]) {
      if (block?.type !== "tool_result" || !Array.isArray(block.content)) {
        continue;
      }
      const parts = block.content as (ImagePart | null)[];
      const first = parts.find(isBase64Image);
      if (!first) continue;
      const size = base64ImageSize(first.source!.data as string);
      if (size.width !== undefined) block.image_size = size;
      block.content = parts.map((part) => {
        if (!isBase64Image(part)) return part;
        images += 1;
        return { type: "text", text: ARCHIVED_IMAGE_TEXT };
      });
      changed = true;
    }
  }
  // `toolUseResult` repeats the result: an MCP tool's blocks as an array, or a
  // `Read` of an image file as `{ type: "image", file: { base64, … } }`.
  const result = line.toolUseResult;
  if (Array.isArray(result)) {
    line.toolUseResult = (result as (ImagePart | null)[]).map((part) => {
      if (!isBase64Image(part)) return part;
      changed = true;
      return { type: "text", text: ARCHIVED_IMAGE_TEXT };
    });
  } else if (
    typeof result === "object" &&
    result !== null &&
    (result as ImagePart).type === "image" &&
    typeof (result as ImagePart).file?.base64 === "string"
  ) {
    delete (result as ImagePart).file!.base64;
    changed = true;
  }
  return { changed, images };
}

function isBase64Image(part: ImagePart | null): part is ImagePart {
  return (
    part?.type === "image" &&
    part.source?.type === "base64" &&
    typeof part.source.data === "string"
  );
}
