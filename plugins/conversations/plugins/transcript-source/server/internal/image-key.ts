import type { TranscriptImage } from "../../core";

// An image the transcript shows is never copied into an event: the event
// carries a KEY, and the page loads the bytes from the key's own URL. The key
// encodes where the bytes are, so any host answers it with no state of its own
// — a sub-agent's file as well as a conversation's, after a restart as well as
// before.
//
// A key is immutable — it always names the same bytes — which is what lets the
// URL be cached forever:
//   - an inline image is named by its transcript line's position AND uuid. A
//     line is written once and never rewritten; a rewind truncates the file, and
//     the line that later lands at the same offset has another uuid, which the
//     read checks (a mismatch is "gone", never another image).
//   - a prompt's `@/path.png` is named by its path and the file's (mtime, size)
//     when the transcript was read, checked the same way.

/** Where an image's bytes are. */
export type TranscriptImageLocator =
  | {
      kind: "line";
      /** The host's id for the transcript file (a path on the desktop). */
      file: string;
      /** The line's byte offset and length in that file. */
      offset: number;
      length: number;
      /**
       * The line's uuid — the check that the line is still the one keyed. Null
       * for a line without one, which nothing checks (and which is never cached).
       */
      uuid: string | null;
      /** Which image of the line, in `visitInlineImages` order. */
      n: number;
    }
  | { kind: "path"; path: string; mtimeMs: number; size: number };

/** An image's bytes as a host reads them back. */
export interface TranscriptImageBytes {
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export class TranscriptImageKeyError extends Error {}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(key: string): string {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
}

export function encodeImageKey(locator: TranscriptImageLocator): string {
  return toBase64Url(JSON.stringify(locator));
}

/** The locator a key names; throws `TranscriptImageKeyError` on anything that is not a key. */
export function decodeImageKey(key: string): TranscriptImageLocator {
  let value: unknown;
  try {
    value = JSON.parse(fromBase64Url(key));
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof DOMException) {
      throw new TranscriptImageKeyError(`not a transcript image key: ${key}`);
    }
    throw err;
  }
  const v = value as Record<string, unknown>;
  if (
    v.kind === "line" &&
    typeof v.file === "string" &&
    typeof v.offset === "number" &&
    typeof v.length === "number" &&
    (typeof v.uuid === "string" || v.uuid === null) &&
    typeof v.n === "number"
  ) {
    return {
      kind: "line",
      file: v.file,
      offset: v.offset,
      length: v.length,
      uuid: v.uuid,
      n: v.n,
    };
  }
  if (
    v.kind === "path" &&
    typeof v.path === "string" &&
    typeof v.mtimeMs === "number" &&
    typeof v.size === "number"
  ) {
    return { kind: "path", path: v.path, mtimeMs: v.mtimeMs, size: v.size };
  }
  throw new TranscriptImageKeyError(`not a transcript image key: ${key}`);
}

/** One inline image of a line: its bytes as the line holds them, and how to put a reference in their place. */
interface InlineImage {
  mime: string;
  base64: string;
  replace: (image: TranscriptImage) => void;
}

interface RawImageBlock {
  type?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown };
  content?: unknown;
}

/**
 * Every inline image of a transcript line, in one fixed order — the order an
 * image's `n` counts in, so the reader of a key walks the line the same way the
 * writer did: a user message's image blocks, then an attached file's image.
 */
export function visitInlineImages(
  line: Record<string, unknown>,
  visit: (image: InlineImage) => void,
): void {
  const message = line.message as { content?: unknown } | undefined;
  if (Array.isArray(message?.content)) {
    for (const block of message.content as (RawImageBlock | null)[]) {
      const source = block?.source;
      if (
        block?.type === "image" &&
        source?.type === "base64" &&
        typeof source.data === "string"
      ) {
        const mime =
          typeof source.media_type === "string"
            ? source.media_type
            : "image/jpeg";
        visit({
          mime,
          base64: source.data,
          replace: (image) => {
            block.source = { type: "ref", media_type: mime, data: image.key };
          },
        });
      }
    }
  }
  const attachment = line.attachment as
    | { content?: { type?: unknown; file?: Record<string, unknown> } }
    | undefined;
  const file = attachment?.content?.file;
  if (
    attachment?.content?.type === "image" &&
    file &&
    typeof file.base64 === "string"
  ) {
    const mime = typeof file.type === "string" ? file.type : "image/png";
    visit({
      mime,
      base64: file.base64,
      replace: (image) => {
        delete file.base64;
        file.image = image;
      },
    });
  }
}

/** The `n`-th inline image of a line, or null when it has fewer. */
export function inlineImageAt(
  line: Record<string, unknown>,
  n: number,
): { mime: string; base64: string } | null {
  let i = 0;
  let found: { mime: string; base64: string } | null = null;
  visitInlineImages(line, (image) => {
    if (i++ === n) found = { mime: image.mime, base64: image.base64 };
  });
  return found;
}

export function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

/** The mime of an image file, by its extension. */
export function imageMimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_MIME[ext] ?? "image/png";
}

/** What resolving a key found: the bytes, or that the key no longer names them. */
export type TranscriptImageRead =
  ({ kind: "found" } & TranscriptImageBytes) | { kind: "gone"; reason: string };

/** The reads a host answers an image key with — its own storage. */
export interface TranscriptImageIo {
  /** `length` bytes of transcript `file` from `offset`; null when the file is not there. */
  readRange(
    file: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null>;
  /** A prompt image's (mtime, size) and bytes; null when it is not there. */
  readPath(path: string): Promise<{
    mtimeMs: number;
    size: number;
    bytes: Uint8Array<ArrayBuffer>;
  } | null>;
}

/**
 * The bytes a key names, read through the host's `io` — or `gone` when the
 * line or file it was minted from has changed since (a rewind truncated the
 * transcript, the prompt's image was overwritten). Never another image.
 */
export async function readImageKey(
  key: string,
  io: TranscriptImageIo,
): Promise<TranscriptImageRead> {
  const locator = decodeImageKey(key);
  if (locator.kind === "path") {
    const file = await io.readPath(locator.path);
    if (!file) return { kind: "gone", reason: `${locator.path} is not there` };
    if (file.mtimeMs !== locator.mtimeMs || file.size !== locator.size) {
      return { kind: "gone", reason: `${locator.path} changed` };
    }
    return {
      kind: "found",
      mime: imageMimeOf(locator.path),
      bytes: file.bytes,
    };
  }
  const bytes = await io.readRange(
    locator.file,
    locator.offset,
    locator.length,
  );
  if (!bytes || bytes.length !== locator.length) {
    return { kind: "gone", reason: `${locator.file} no longer holds the line` };
  }
  let line: Record<string, unknown>;
  try {
    line = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: "gone", reason: `${locator.file} no longer holds the line` };
  }
  if (locator.uuid !== null && line.uuid !== locator.uuid) {
    return { kind: "gone", reason: `${locator.file} no longer holds the line` };
  }
  const image = inlineImageAt(line, locator.n);
  if (!image) return { kind: "gone", reason: "the line has no such image" };
  return { kind: "found", mime: image.mime, bytes: base64Bytes(image.base64) };
}
