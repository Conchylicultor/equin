import {
  blob,
  defineEndpoint,
  interpolatePath,
} from "@plugins/infra/plugins/endpoints/core";

// Served outside implement(): the response is the image's own bytes with its
// own mime and cache headers. The declaration types the client side only —
// `transcriptImageUrl` builds the address an `<img>` reads.
export const getTranscriptImage = defineEndpoint({
  route: "GET /api/transcript-images/:key",
  response: blob(),
});

/**
 * The URL an `<img>` reads a transcript image from, by its
 * `TranscriptImage.key`. Built from the endpoint's own route, so every
 * renderer of a transcript image (a pasted image, an image in a prompt, an
 * attached file) cannot drift from the route that serves it. The key names its
 * bytes forever, so the response is cached forever.
 */
export function transcriptImageUrl(key: string): string {
  return interpolatePath(getTranscriptImage.path, { key });
}
