import {
  TranscriptImageKeyError,
  TranscriptSource,
} from "@plugins/conversations/plugins/transcript-source/server";

/**
 * Serve a transcript image by its key. The key names the bytes forever (the
 * host re-checks the line's uuid, or the file's mtime and size, and answers
 * `gone` rather than other bytes), so a found image is cached immutably. A
 * string that is not a key is a 400; a key whose line or file has changed since
 * is a 410.
 *
 * The bytes are rendered inert whatever they hold — an SVG is a document — the
 * way host-fs serves a host file.
 */
export async function handleTranscriptImage(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const key = params.key;
  if (!key) return new Response("Missing key", { status: 400 });
  let read;
  try {
    read = await TranscriptSource.get().image(key);
  } catch (err) {
    if (err instanceof TranscriptImageKeyError) {
      return new Response(err.message, { status: 400 });
    }
    throw err;
  }
  if (read.kind === "gone") return new Response(read.reason, { status: 410 });
  return new Response(read.bytes, {
    headers: {
      "Content-Type": read.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cross-Origin-Resource-Policy": "same-site",
    },
  });
}
