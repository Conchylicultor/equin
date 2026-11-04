import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";

// Served outside implement(): the response is the image's own bytes with its
// own mime and cache headers. The declaration types the client side only —
// `transcriptImage` builds the asset an `<img>` loads.
export const getTranscriptImage = defineEndpoint({
  route: "GET /api/transcript-images/:key",
  response: blob(),
});

/**
 * The asset a transcript image's bytes load from, by its
 * `TranscriptImage.key` — through `useAssetSrc` (`AssetThumbnail`), over the
 * subtree's transport, never as a bare URL. Built from the endpoint's own
 * route, so every renderer of a transcript image (a pasted image, an image in
 * a prompt, an attached file) cannot drift from the route that serves it. The
 * key names its bytes forever, so the response is cached forever.
 */
export function transcriptImage(key: string): AssetPath {
  return assetPath(getTranscriptImage, { key });
}
